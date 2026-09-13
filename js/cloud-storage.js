/*
 * CLOUD-STORAGE.JS — Supabase Storage + Database backend.
 *
 * TO ENABLE:
 * 1. Create a free project at supabase.com.
 * 2. Storage → New bucket → name it "photobooth" → toggle Public ON.
 * 3. Project Settings → API → copy "Project URL" and "anon public" key
 *    into CLOUD_CONFIG below.
 * 4. Set CLOUD_CONFIG.enabled = true.
 * 5. Run supabase-templates-setup.sql in the Supabase SQL Editor to create
 *    the `templates` table and RLS policies.
 *
 * Gallery URL format: https://studrio.cc/g/#<sessionId>
 */

/* ===========================================================
 * OFFLINE UPLOAD QUEUE
 *
 * When an upload fails (no internet / Supabase unreachable), the full
 * session blob is saved to a local IndexedDB queue ("studrioQueue").
 * A background retry loop checks connectivity every 15 s and drains
 * the queue automatically once the connection returns.
 *
 * Public API (auto-starts on load):
 *   offlineQueue.enqueue(sessionData)   — called by cloudStorage.saveSession()
 *   offlineQueue.status()               — { pending: N }
 * =========================================================== */
const offlineQueue = (() => {
  const DB_NAME    = "studrioQueue";
  const DB_VERSION = 1;
  const STORE      = "sessions";
  const RETRY_MS   = 15_000;

  let _db   = null;
  let _loop = null;

  // ── IndexedDB helpers ──────────────────────────────────────────────────────
  function _openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror    = (e) => reject(e.target.error);
    });
  }

  async function _put(record) {
    const db  = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readwrite");
      const st  = tx.objectStore(STORE);
      const req = st.put(record);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function _getAll() {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readonly");
      const st  = tx.objectStore(STORE);
      const req = st.getAll();
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function _delete(id) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readwrite");
      const st  = tx.objectStore(STORE);
      const req = st.delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  // ── Blob serialization (IDB can't store Blob URLs, store actual bytes) ─────
  async function _serializeSession(sessionData) {
    async function blobToBase64(blob) {
      if (!blob) return null;
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve({ b64: reader.result.split(",")[1], type: blob.type });
        reader.onerror = () => reject(new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
    }
    const individualPhotos = Array.isArray(sessionData.individualPhotos)
      ? await Promise.all(sessionData.individualPhotos.map((b) => blobToBase64(b)))
      : null;
    return {
      id:         sessionData.id,
      frameType:  sessionData.frameType,
      design:     sessionData.design,
      enqueuedAt: Date.now(),
      finalStripPng:   await blobToBase64(sessionData.finalStripPng),
      finalStripVideo: await blobToBase64(sessionData.finalStripVideo),
      printReadyPng:   await blobToBase64(sessionData.printReadyPng),
      individualPhotos
    };
  }

  function _deserializeSession(record) {
    function b64ToBlob(entry) {
      if (!entry) return null;
      const bytes = atob(entry.b64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      return new Blob([arr], { type: entry.type });
    }
    return {
      id:              record.id,
      frameType:       record.frameType,
      design:          record.design,
      finalStripPng:   b64ToBlob(record.finalStripPng),
      finalStripVideo: b64ToBlob(record.finalStripVideo),
      printReadyPng:   b64ToBlob(record.printReadyPng),
      individualPhotos: Array.isArray(record.individualPhotos)
        ? record.individualPhotos.map((e) => b64ToBlob(e))
        : []
    };
  }

  // ── Online detection ───────────────────────────────────────────────────────
  async function _isOnline() {
    if (!navigator.onLine) return false;
    // Ping Supabase health endpoint (zero-byte HEAD is cheapest)
    try {
      const res = await fetch(
        `${CLOUD_CONFIG.supabaseUrl}/rest/v1/`,
        { method: "HEAD", signal: AbortSignal.timeout(5000) }
      );
      return res.ok || res.status < 500;
    } catch (_) {
      return false;
    }
  }

  // ── Retry loop ─────────────────────────────────────────────────────────────
  async function _drain() {
    let items;
    try { items = await _getAll(); } catch (e) { return; }
    if (!items.length) return;

    const online = await _isOnline();
    if (!online) return;

    console.info(`[offlineQueue] Connection restored — retrying ${items.length} queued session(s).`);

    for (const record of items) {
      try {
        const sessionData = _deserializeSession(record);
        // Call _saveSessionOnce directly — NOT saveSession() — to avoid
        // re-enqueuing the session if a transient error occurs mid-retry.
        // _saveSessionOnce treats "already exists" errors as success, so
        // partial uploads from the original session are handled gracefully.
        await cloudStorage._saveSessionOnce(sessionData);
        await _delete(record.id);
        console.info(`[offlineQueue] ✓ session ${record.id} uploaded and removed from queue.`);
      } catch (err) {
        console.warn(`[offlineQueue] Retry failed for ${record.id}:`, err.message || err);
        // Leave it in the queue; try again next interval
      }
    }
  }

  function _startLoop() {
    if (_loop) return;
    _loop = setInterval(_drain, RETRY_MS);
    // Also try immediately when coming back online
    window.addEventListener("online", _drain);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  async function enqueue(sessionData) {
    try {
      const record = await _serializeSession(sessionData);
      await _put(record);
      console.info(`[offlineQueue] Session ${sessionData.id} saved to offline queue (${await _getAll().then(a => a.length)} pending).`);
    } catch (err) {
      console.error("[offlineQueue] Could not save to IndexedDB:", err.message || err);
    }
  }

  async function status() {
    try {
      const all = await _getAll();
      return { pending: all.length };
    } catch (_) {
      return { pending: 0 };
    }
  }

  // Auto-start the retry loop as soon as the module loads
  _startLoop();

  return { enqueue, status };
})();

const CLOUD_CONFIG = {
  enabled: true,
  supabaseUrl: "https://gbhsitdxorjocsetueul.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiaHNpdGR4b3Jqb2NzZXR1ZXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyNDg5NjksImV4cCI6MjEwNDgyNDk2OX0.n8flvS52X6Svhj1WmMrwORCxQIBzXf6ZexATmc_jJU4",
  bucketName: "photobooth",
  galleryBaseUrl: "https://studrio.cc/g/#"
};

let _supabaseClient = null;
function getSupabaseClient() {
  if (!CLOUD_CONFIG.enabled) return null;
  if (_supabaseClient) return _supabaseClient;
  if (typeof supabase === "undefined") {
    console.warn("[cloudStorage] Supabase SDK not loaded — check the script tag in index.html");
    return null;
  }
  _supabaseClient = supabase.createClient(CLOUD_CONFIG.supabaseUrl, CLOUD_CONFIG.supabaseAnonKey);
  return _supabaseClient;
}

function videoExtensionFor(blob) {
  return blob && blob.type && blob.type.includes("mp4") ? "mp4" : "webm";
}

/*
 * ── UPLOAD COMPRESSION ──────────────────────────────────────────────────
 *
 * stripModule.exportPNG()/exportPrintPNG() produce full-resolution
 * 2400×3600 RGBA PNG canvases (5MB+ each). That's fine for local use, but
 * it's what was making uploads slow, delaying the "upload complete" QR
 * state, and adding avoidable data to every session's storage footprint.
 *
 * compressPhotoForUpload() re-encodes that PNG as a 24-bit JPEG at the
 * SAME 2400×3600 pixel dimensions (no resizing, no crop) — matching the
 * DSLRBooth-style export spec (2400×3600 @ 96 DPI, 24-bit, ideally <1MB)
 * — while keeping quality effectively indistinguishable for photo content.
 * It only runs right before the network upload, on a throwaway canvas, so
 * it never touches sessionState's original blobs used anywhere else (e.g.
 * printing.js renders its own copy for the physical printer independently
 * of these Supabase uploads).
 */
async function compressPhotoForUpload(blob, { maxBytes = 1_000_000, startQuality = 0.92, minQuality = 0.6 } = {}) {
  if (!blob) return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");

    // JPEG has no alpha channel. The exports are fully opaque already, but
    // flattening onto white first guards against stray semi-transparent
    // edge pixels turning black on re-encode.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === "function") bitmap.close();

    let quality  = startQuality;
    let jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

    // Step quality down only if still over target size; floors at minQuality
    // so we never sacrifice visible sharpness chasing the last few KB.
    while (jpegBlob && jpegBlob.size > maxBytes && quality > minQuality) {
      quality  = Math.max(minQuality, quality - 0.08);
      jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }

    if (!jpegBlob) return blob; // encoder failed — upload the original PNG rather than nothing
    return await _writeJpegDensity96(jpegBlob);
  } catch (e) {
    console.warn("[cloudStorage] Photo compression failed, uploading original:", e.message || e);
    return blob;
  }
}

/*
 * _writeJpegDensity96 — patches the JFIF APP0 header's density fields to
 * 96 DPI (units=1, X/Ydensity=96) so the uploaded JPEG carries the same
 * 96 DPI tag DSLRBooth stamps on its exports. canvas.toBlob's JPEG encoder
 * always writes a standard JFIF header at a fixed offset; if that shape
 * ever doesn't match (e.g. a future browser encoder), this just leaves the
 * blob untouched rather than risk corrupting it.
 */
async function _writeJpegDensity96(jpegBlob) {
  try {
    const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
    const isJfif =
      bytes[0] === 0xFF && bytes[1] === 0xD8 &&       // SOI
      bytes[2] === 0xFF && bytes[3] === 0xE0 &&       // APP0
      bytes[9]  === 0x4A && bytes[10] === 0x46 &&      // 'J' 'F'
      bytes[11] === 0x49 && bytes[12] === 0x46;        // 'I' 'F'
    if (isJfif) {
      bytes[13] = 1;                        // units: 1 = dots per inch
      bytes[14] = 0x00; bytes[15] = 0x60;   // Xdensity = 96
      bytes[16] = 0x00; bytes[17] = 0x60;   // Ydensity = 96
      return new Blob([bytes], { type: "image/jpeg" });
    }
  } catch (e) {
    console.warn("[cloudStorage] Could not set JPEG DPI metadata:", e.message || e);
  }
  return jpegBlob;
}

/*
 * _isAlreadyExistsError — returns true for Supabase Storage / PostgREST
 * errors that mean "this resource was already uploaded".
 *
 * Supabase Storage surfaces this as:
 *   { statusCode: "23505", error: "Duplicate", message: "The resource already exists" }
 * PostgREST (DB insert) surfaces it as:
 *   { code: "23505", message: "duplicate key value violates unique constraint …" }
 *
 * Treating these as success in the offline-retry path prevents infinite loops
 * when reconnecting after a session that was already partially uploaded before
 * the connection dropped.
 */
function _isAlreadyExistsError(err) {
  if (!err) return false;
  const code    = String(err.code    || err.statusCode || "");
  const message = String(err.message || err.error      || "").toLowerCase();
  return (
    code === "23505" ||
    message.includes("already exists") ||
    message.includes("duplicate key") ||
    message.includes("duplicate")
  );
}

const cloudStorage = {
  isAvailable() {
    return CLOUD_CONFIG.enabled && typeof supabase !== "undefined"
      && !!CLOUD_CONFIG.supabaseUrl && !!CLOUD_CONFIG.supabaseAnonKey;
  },

  async uploadBlob(blob, path) {
    const client = getSupabaseClient();
    // upsert is intentionally false — every session has a unique ID so paths
    // are never reused. upsert:true internally requires UPDATE permission on
    // storage.objects which the anon role does not have.
    //
    // "The resource already exists" (Supabase error code "23505" or message
    // containing "already exists") means the file was uploaded successfully
    // during the original attempt before the connection dropped. In that case
    // the queued retry should treat it as done and just return the public URL
    // — NOT throw and loop forever.
    const { error } = await client.storage.from(CLOUD_CONFIG.bucketName).upload(path, blob, {
      upsert: false,
      contentType: blob.type || "application/octet-stream"
    });
    if (error && !_isAlreadyExistsError(error)) throw error;
    const { data } = client.storage.from(CLOUD_CONFIG.bucketName).getPublicUrl(path);
    return data.publicUrl;
  },

  async saveSession(sessionData) {
    // ── Offline guard: if upload throws, enqueue and return gracefully ────────
    // The actual upload attempt is wrapped below; on catch we hand off to the
    // offline queue so the booth can keep running without interruption.
    return this._saveSessionOnce(sessionData).catch(async (err) => {
      console.warn("[cloudStorage] Upload failed — queuing for retry:", err.message || err);
      await offlineQueue.enqueue(sessionData);
      // Propagate so qr.js can show the "Upload unavailable" fallback QR
      throw err;
    });
  },

  async _saveSessionOnce(sessionData) {
    // Compress the two full-resolution PNG exports to 24-bit JPEG right
    // before they go over the network (see compressPhotoForUpload above).
    // Mutating sessionData in place means a failed attempt re-queues the
    // already-compressed blobs for offline retry instead of the original
    // 5MB+ PNGs, and the `type` check keeps a retry from re-compressing
    // an already-compressed blob.
    if (sessionData.finalStripPng && sessionData.finalStripPng.type !== "image/jpeg") {
      sessionData.finalStripPng = await compressPhotoForUpload(sessionData.finalStripPng);
    }
    if (sessionData.printReadyPng && sessionData.printReadyPng.type !== "image/jpeg") {
      sessionData.printReadyPng = await compressPhotoForUpload(sessionData.printReadyPng);
    }

    const finalStripUrl = sessionData.finalStripPng
      ? await this.uploadBlob(sessionData.finalStripPng, `sessions/${sessionData.id}/strip.jpg`)
      : null;

    const finalStripVideoUrl = sessionData.finalStripVideo
      ? await this.uploadBlob(sessionData.finalStripVideo, `sessions/${sessionData.id}/strip-live.${videoExtensionFor(sessionData.finalStripVideo)}`)
      : null;

    const printReadyUrl = sessionData.printReadyPng
      ? await this.uploadBlob(sessionData.printReadyPng, `sessions/${sessionData.id}/strip-print.jpg`)
      : null;

    // Individual photos — qr.js's _compressIndividualPhotos() already
    // re-encoded these 4 (or fewer) shots as JPEG and downscaled them so
    // the set totals ≤1.5MB, so no further compression happens here, just
    // upload. Order matches selectedShots (a missing/null shot at index i
    // uploads nothing for that slot and leaves a null in the paths array
    // so gallery.js's grid can skip it while keeping the other positions
    // correct). Each upload is isolated in its own try/catch — one failed
    // photo (e.g. a transient network blip) must not throw and abort the
    // Promise.all below, which would otherwise take the strip/video/QR
    // upload down with it even though those succeeded independently.
    const individualPhotoPaths = [];
    if (Array.isArray(sessionData.individualPhotos) && sessionData.individualPhotos.length) {
      await Promise.all(
        sessionData.individualPhotos.map(async (photoBlob, i) => {
          if (!photoBlob) { individualPhotoPaths[i] = null; return; }
          const path = `sessions/${sessionData.id}/photo-${i + 1}.jpg`;
          try {
            await this.uploadBlob(photoBlob, path);
            individualPhotoPaths[i] = path;
          } catch (e) {
            console.warn(`[cloudStorage] Individual photo ${i + 1} upload failed:`, e.message || e);
            individualPhotoPaths[i] = null;
          }
        })
      );
      console.info(
        `[cloudStorage] Individual photos: ${individualPhotoPaths.filter(Boolean).length}/${sessionData.individualPhotos.length} uploaded for session ${sessionData.id}.`
      );
    }

    const sessionJson = {
      id: sessionData.id,
      frameType: sessionData.frameType,
      design: sessionData.design,
      stripPath:       finalStripUrl      ? `sessions/${sessionData.id}/strip.jpg`                                             : null,
      stripVideoPath:  finalStripVideoUrl ? `sessions/${sessionData.id}/strip-live.${videoExtensionFor(sessionData.finalStripVideo)}` : null,
      printReadyPath:  printReadyUrl      ? `sessions/${sessionData.id}/strip-print.jpg`                                       : null,
      individualPhotoPaths: individualPhotoPaths.length ? individualPhotoPaths : null,
      createdAt: new Date().toISOString()
    };

    const jsonBlob = new Blob([JSON.stringify(sessionJson)], { type: "application/json" });
    await this.uploadBlob(jsonBlob, `sessions/${sessionData.id}/session.json`);

    try {
      const client = getSupabaseClient();
      const { error } = await client.from("sessions").insert({
        id: sessionData.id,
        frame_type: sessionData.frameType,
        design: sessionData.design,
        final_strip_url: finalStripUrl,
        final_strip_video_url: finalStripVideoUrl,
        print_ready_url: printReadyUrl
      });
      // 23505 = unique_violation: row was already inserted on the first
      // (partial) attempt before the connection dropped — safe to ignore.
      if (error && !_isAlreadyExistsError(error)) throw error;
      if (error && _isAlreadyExistsError(error)) {
        console.info("[cloudStorage] sessions row already exists — skipping insert (idempotent retry).");
      }
    } catch (e) {
      console.error("[cloudStorage] Could not mirror session into sessions table:", e.message || e);
    }

    return { url: `${CLOUD_CONFIG.galleryBaseUrl}${sessionData.id}` };
  },

  async getSession(sessionId) {
    const client = getSupabaseClient();
    const { data: urlData } = client.storage
      .from(CLOUD_CONFIG.bucketName)
      .getPublicUrl(`sessions/${sessionId}/session.json`);
    const res = await fetch(`${urlData.publicUrl}?t=${Date.now()}`);
    if (!res.ok) return null;
    const session = await res.json();

    function sign(path) {
      if (!path) return null;
      const { data } = client.storage
        .from(CLOUD_CONFIG.bucketName)
        .getPublicUrl(path);
      return data.publicUrl;
    }

    function isPath(v) { return v && v.startsWith("sessions/"); }

    const [finalStripUrl, finalStripVideoUrl, printReadyUrl] = await Promise.all([
      isPath(session.stripPath)      ? sign(session.stripPath)      : (session.finalStripUrl || null),
      isPath(session.stripVideoPath) ? sign(session.stripVideoPath) : (session.finalStripVideoUrl || null),
      isPath(session.printReadyPath) ? sign(session.printReadyPath) : (session.printReadyUrl || null)
    ]);

    // Individual photo grid (up to 4) — session.individualPhotoPaths is the
    // array _saveSessionOnce() wrote (nulls preserved for any skipped
    // slot); older sessions saved before this field existed just won't
    // have it, so the grid stays hidden for them (gallery.js already
    // handles an empty/missing array).
    if (!Array.isArray(session.individualPhotoPaths)) {
      console.info(`[cloudStorage] session ${sessionId} has no individualPhotoPaths — likely saved before that field existed; photo grid will stay hidden.`);
    }
    const individualPhotoUrls = Array.isArray(session.individualPhotoPaths)
      ? session.individualPhotoPaths.map((p) => (isPath(p) ? sign(p) : (p || null)))
      : (session.individualPhotoUrls || []);

    return {
      id: session.id,
      frameType: session.frameType,
      design: session.design,
      finalStripUrl,
      finalStripVideoUrl,
      printReadyUrl,
      individualPhotoUrls,
      photos: []
    };
  },

  async logPrintEvent(sessionId, quantity) {
    try {
      const client = getSupabaseClient();
      const { error } = await client.from("print_events").insert({ session_id: sessionId, quantity: quantity || 1 });
      if (error) throw error;
    } catch (e) {
      console.error("[cloudStorage] Could not log print event:", e.message || e);
    }
  },

  /*
   * saveFlipbookPrintSheets — uploads the two pixel-exact A4 sheets a live
   * flipbook session just sent to the printer (see printing.js's flipbook
   * _autoPrint() branch) and records their URLs on the session's row so
   * Admin > Sessions can reprint later without regenerating the flipbook
   * (the guest's original 19 extracted frames aren't kept around after
   * this point — the sheets themselves are the only durable record).
   *
   * Reuses the existing `print_ready_url` column for sheet 1 (mirrors every
   * other product's single print-ready file) and a new `print_ready_url_2`
   * column for sheet 2 — requires:
   *   ALTER TABLE sessions ADD COLUMN IF NOT EXISTS print_ready_url_2 text;
   * on Supabase, plus an UPDATE policy permitting the anon role to update
   * its own just-inserted row (INSERT-only policies, e.g. the one already
   * used by _saveSessionOnce()'s insert, will reject this call). Wrapped in
   * try/catch and never thrown to the caller — this is best-effort
   * bookkeeping and must never block or fail the guest's actual print job.
   */
  async saveFlipbookPrintSheets(sessionId, page1Blob, page2Blob) {
    try {
      const [printReadyUrl, printReadyUrl2] = await Promise.all([
        this.uploadBlob(page1Blob, `sessions/${sessionId}/print-a4-1.png`),
        this.uploadBlob(page2Blob, `sessions/${sessionId}/print-a4-2.png`)
      ]);

      const client = getSupabaseClient();
      // .select() after .update() is required to detect an RLS-blocked
      // update: PostgREST does NOT return an `error` when an UPDATE's RLS
      // policy silently matches 0 rows — it reports success with an empty
      // result. Without forcing a return payload here, a missing/incorrect
      // UPDATE policy for the anon role would fail completely silently,
      // leaving print_ready_url null with no warning anywhere.
      const { data, error } = await client.from("sessions")
        .update({ print_ready_url: printReadyUrl, print_ready_url_2: printReadyUrl2 })
        .eq("id", sessionId)
        .select();
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(
          `Update matched 0 rows for session ${sessionId} — the sessions table's ` +
          `UPDATE row-level-security policy for the anon role is missing, disabled, ` +
          `or scoped incorrectly.`
        );
      }

      return { printReadyUrl, printReadyUrl2 };
    } catch (e) {
      console.warn("[cloudStorage] Could not save flipbook print sheets for later reprint:", e.message || e);
      return null;
    }
  }
};

/* ===========================================================
 * ADMIN-ONLY FUNCTIONS — used exclusively by admin pages.
 * Relies on an authenticated Supabase session; RLS policies
 * in supabase-templates-setup.sql reject anonymous callers.
 * =========================================================== */
const adminStorage = {
  getClient() {
    return getSupabaseClient();
  },

  async signIn(email, password) {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },

  async signOut() {
    const client = getSupabaseClient();
    await client.auth.signOut();
  },

  async getCurrentUser() {
    const client = getSupabaseClient();
    const { data } = await client.auth.getUser();
    return data?.user || null;
  },

  onAuthChange(callback) {
    const client = getSupabaseClient();
    client.auth.onAuthStateChange((_event, session) => callback(session?.user || null));
  },

  async listAllSessions() {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("sessions")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async deleteSession(sessionId) {
    const client = getSupabaseClient();
    const prefix = `sessions/${sessionId}`;
    const { data: files, error: listError } = await client.storage
      .from(CLOUD_CONFIG.bucketName)
      .list(prefix);
    if (listError) throw listError;
    if (files && files.length) {
      const paths = files.map((f) => `${prefix}/${f.name}`);
      const { error: removeError } = await client.storage.from(CLOUD_CONFIG.bucketName).remove(paths);
      if (removeError) throw removeError;
    }
    const { error: deleteRowError } = await client.from("sessions").delete().eq("id", sessionId);
    if (deleteRowError) throw deleteRowError;
  },

  async getStats() {
    const client = getSupabaseClient();
    const [{ count: photostripCount, error: countError }, printResult, sessions] = await Promise.all([
      client.from("sessions").select("*", { count: "exact", head: true }),
      client.from("print_events").select("quantity"),
      this.listAllSessions()
    ]);
    if (countError) throw countError;
    if (printResult.error) throw printResult.error;
    const totalCopiesPrinted = (printResult.data || []).reduce((sum, row) => sum + (row.quantity || 0), 0);
    let totalBytes = 0;
    for (const session of sessions) {
      const { data: files, error } = await client.storage
        .from(CLOUD_CONFIG.bucketName)
        .list(`sessions/${session.id}`);
      if (error) continue;
      totalBytes += (files || []).reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
    }
    return { photostripCount: photostripCount || 0, totalCopiesPrinted, totalStorageBytes: totalBytes };
  }
};

/* ===========================================================
 * TEMPLATE MANAGEMENT — admin-only, authenticated.
 * =========================================================== */
const adminTemplates = {
  getClient() {
    return getSupabaseClient();
  },

  /*
   * Lists all templates, ordered by sort_order then created_at.
   * Returns resolved public URLs for thumbnail and overlay files.
   */
  async listTemplates() {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("templates")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at",  { ascending: true });
    if (error) throw error;

    // Resolve public storage URLs for display in the admin panel
    return (data || []).map((t) => ({
      ...t,
      thumbnail_url:             t.thumbnail_path          ? this._publicUrl(t.thumbnail_path)          : null,
      overlay_url_2x6:           t.overlay_path_2x6        ? this._publicUrl(t.overlay_path_2x6)        : null,
      overlay_url_4x6:           t.overlay_path_4x6        ? this._publicUrl(t.overlay_path_4x6)        : null,
      keychain_overlay_url:      t.keychain_overlay_path   ? this._publicUrl(t.keychain_overlay_path)   : null,
      overlay_url_long_duo:               t.overlay_path_long_duo              ? this._publicUrl(t.overlay_path_long_duo)              : null,
      overlay_url_long_mini:              t.overlay_path_long_mini             ? this._publicUrl(t.overlay_path_long_mini)             : null,
      overlay_url_film_duo:               t.overlay_path_film_duo              ? this._publicUrl(t.overlay_path_film_duo)              : null,
      overlay_url_wide_mini:              t.overlay_path_wide_mini             ? this._publicUrl(t.overlay_path_wide_mini)             : null,
      // Strip preview overlays — used only on the selection/printing preview canvas,
      // never for the final print output. Each is sized to the preview region.
      preview_overlay_url_long_duo:       t.preview_overlay_path_long_duo      ? this._publicUrl(t.preview_overlay_path_long_duo)      : null,
      preview_overlay_url_long_mini:      t.preview_overlay_path_long_mini     ? this._publicUrl(t.preview_overlay_path_long_mini)     : null,
      preview_overlay_url_film_duo:       t.preview_overlay_path_film_duo      ? this._publicUrl(t.preview_overlay_path_film_duo)      : null,
      preview_overlay_url_wide_mini:      t.preview_overlay_path_wide_mini     ? this._publicUrl(t.preview_overlay_path_wide_mini)     : null,
      // Flipbook — 3 independent template slots (Cover Page, A4 Page 1, A4 Page 2).
      overlay_url_flipbook_cover:         t.overlay_path_flipbook_cover        ? this._publicUrl(t.overlay_path_flipbook_cover)        : null,
      overlay_url_flipbook_a4_1:          t.overlay_path_flipbook_a4_1         ? this._publicUrl(t.overlay_path_flipbook_a4_1)         : null,
      overlay_url_flipbook_a4_2:          t.overlay_path_flipbook_a4_2         ? this._publicUrl(t.overlay_path_flipbook_a4_2)         : null,
      // Flipbook Overlay — screen-only decorative frame graphic for the
      // Video Selection preview and Print & QR video loop (never printed).
      overlay_url_flipbook_preview:       t.overlay_path_flipbook_preview      ? this._publicUrl(t.overlay_path_flipbook_preview)      : null
    }));
  },

  _publicUrl(storagePath) {
    const client = getSupabaseClient();
    const { data } = client.storage.from(CLOUD_CONFIG.bucketName).getPublicUrl(storagePath);
    return data.publicUrl;
  },

  /*
   * Uploads a new template.
   * Parameters:
   *   name          — display name (string)
   *   assetType     — "Originals" | "Designs" | "Accessories"
   *   file2x6                — File object for the 2×6 overlay PNG (or null)
   *   file4x6                — File object for the 4×6 overlay PNG (or null)
   *   fileLongDuo            — File object for the Long Duo overlay PNG (or null)
   *   fileLongMini           — File object for the Long Mini overlay PNG (or null)
   *   fileFilmDuo            — File object for the Film Duo overlay PNG (or null)
   *   fileWideMini           — File object for the Wide Mini overlay PNG (or null)
   *   thumbFile              — File object for the thumbnail image (or null)
   *   previewFileLongDuo     — File object for the Long Duo STRIP PREVIEW overlay (or null)
   *   previewFileLongMini    — File object for the Long Mini STRIP PREVIEW overlay (or null)
   *   previewFileFilmDuo     — File object for the Film Duo STRIP PREVIEW overlay (or null)
   *   previewFileWideMini    — File object for the Wide Mini STRIP PREVIEW overlay (or null)
   *   fileFlipbookCover      — File object for the Flipbook Cover Page slot (or null)
   *   fileFlipbookA4Page1    — File object for the Flipbook A4 Page 1 slot (or null)
   *   fileFlipbookA4Page2    — File object for the Flipbook A4 Page 2 slot (or null)
   *   fileFlipbookPreview    — File object for the Flipbook Overlay (screen preview only, or null)
   *
   * Strip preview overlays are used ONLY on the selection/printing preview canvas
   * (not for final print). They are sized to the preview region:
   *   long-duo / long-mini / film-duo → 1200 × 3600 px
   *   wide-mini                       → 2400 × 1800 px
   *
   * Flipbook templates are a single record with 3 independent overlay slots
   * instead of one shared frame PNG:
   *   Cover Page — 1200 × 666 px, 300 DPI
   *   A4 Page 1  — 2480 × 3508 px, 300 DPI (matches FLIPBOOK_LAYOUT_CONFIG)
   *   A4 Page 2  — 2480 × 3508 px, 300 DPI
   *
   * Storage layout in the photobooth bucket:
   *   templates/<slug>/overlay_2x6.png
   *   templates/<slug>/overlay_4x6.png
   *   templates/<slug>/overlay_long_duo.png
   *   templates/<slug>/overlay_long_mini.png
   *   templates/<slug>/overlay_film_duo.png
   *   templates/<slug>/overlay_wide_mini.png
   *   templates/<slug>/preview_overlay_long_duo.png
   *   templates/<slug>/preview_overlay_long_mini.png
   *   templates/<slug>/preview_overlay_film_duo.png
   *   templates/<slug>/preview_overlay_wide_mini.png
   *   templates/<slug>/overlay_flipbook_cover.png
   *   templates/<slug>/overlay_flipbook_a4_1.png
   *   templates/<slug>/overlay_flipbook_a4_2.png
   *   templates/<slug>/overlay_flipbook_preview.png
   *   templates/<slug>/thumbnail.png
   */
  async uploadTemplate({ name, assetType, file2x6, file4x6, fileLongDuo, fileLongMini, fileFilmDuo, fileWideMini, thumbFile,
                         previewFileLongDuo, previewFileLongMini, previewFileFilmDuo, previewFileWideMini,
                         fileFlipbookCover, fileFlipbookA4Page1, fileFlipbookA4Page2, fileFlipbookPreview }) {
    const client = getSupabaseClient();

    // Derive a URL-safe slug from the name for the storage prefix
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 48);
    // Append a short timestamp to avoid collisions on same-name uploads
    const prefix = `templates/${slug}-${Date.now()}`;

    const [
      overlayPath2x6,
      overlayPath4x6,
      overlayPathLongDuo,
      overlayPathLongMini,
      overlayPathFilmDuo,
      overlayPathWideMini,
      thumbnailPath,
      previewOverlayPathLongDuo,
      previewOverlayPathLongMini,
      previewOverlayPathFilmDuo,
      previewOverlayPathWideMini,
      overlayPathFlipbookCover,
      overlayPathFlipbookA4Page1,
      overlayPathFlipbookA4Page2,
      overlayPathFlipbookPreview
    ] = await Promise.all([
      file2x6             ? this._uploadFile(file2x6,             `${prefix}/overlay_2x6.png`,              "image/png") : Promise.resolve(null),
      file4x6             ? this._uploadFile(file4x6,             `${prefix}/overlay_4x6.png`,              "image/png") : Promise.resolve(null),
      fileLongDuo         ? this._uploadFile(fileLongDuo,         `${prefix}/overlay_long_duo.png`,         "image/png") : Promise.resolve(null),
      fileLongMini        ? this._uploadFile(fileLongMini,        `${prefix}/overlay_long_mini.png`,        "image/png") : Promise.resolve(null),
      fileFilmDuo         ? this._uploadFile(fileFilmDuo,         `${prefix}/overlay_film_duo.png`,         "image/png") : Promise.resolve(null),
      fileWideMini        ? this._uploadFile(fileWideMini,        `${prefix}/overlay_wide_mini.png`,        "image/png") : Promise.resolve(null),
      thumbFile           ? this._uploadFile(thumbFile,           `${prefix}/thumbnail.png`,                 thumbFile.type || "image/png") : Promise.resolve(null),
      previewFileLongDuo  ? this._uploadFile(previewFileLongDuo,  `${prefix}/preview_overlay_long_duo.png`, "image/png") : Promise.resolve(null),
      previewFileLongMini ? this._uploadFile(previewFileLongMini, `${prefix}/preview_overlay_long_mini.png`,"image/png") : Promise.resolve(null),
      previewFileFilmDuo  ? this._uploadFile(previewFileFilmDuo,  `${prefix}/preview_overlay_film_duo.png`, "image/png") : Promise.resolve(null),
      previewFileWideMini ? this._uploadFile(previewFileWideMini, `${prefix}/preview_overlay_wide_mini.png`,"image/png") : Promise.resolve(null),
      fileFlipbookCover   ? this._uploadFile(fileFlipbookCover,   `${prefix}/overlay_flipbook_cover.png`,   "image/png") : Promise.resolve(null),
      fileFlipbookA4Page1 ? this._uploadFile(fileFlipbookA4Page1, `${prefix}/overlay_flipbook_a4_1.png`,    "image/png") : Promise.resolve(null),
      fileFlipbookA4Page2 ? this._uploadFile(fileFlipbookA4Page2, `${prefix}/overlay_flipbook_a4_2.png`,    "image/png") : Promise.resolve(null),
      fileFlipbookPreview ? this._uploadFile(fileFlipbookPreview, `${prefix}/overlay_flipbook_preview.png`, "image/png") : Promise.resolve(null)
    ]);

    // Get the current max sort_order and place the new template at the end
    const { data: maxRow } = await client
      .from("templates")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .single();
    const nextOrder = maxRow ? (maxRow.sort_order || 0) + 1 : 0;

    const { data, error } = await client.from("templates").insert({
      name,
      asset_type:                        assetType || "frame_template",
      overlay_path_2x6:                  overlayPath2x6,
      overlay_path_4x6:                  overlayPath4x6,
      overlay_path_long_duo:             overlayPathLongDuo,
      overlay_path_long_mini:            overlayPathLongMini,
      overlay_path_film_duo:             overlayPathFilmDuo,
      overlay_path_wide_mini:            overlayPathWideMini,
      preview_overlay_path_long_duo:     previewOverlayPathLongDuo,
      preview_overlay_path_long_mini:    previewOverlayPathLongMini,
      preview_overlay_path_film_duo:     previewOverlayPathFilmDuo,
      preview_overlay_path_wide_mini:    previewOverlayPathWideMini,
      overlay_path_flipbook_cover:       overlayPathFlipbookCover,
      overlay_path_flipbook_a4_1:        overlayPathFlipbookA4Page1,
      overlay_path_flipbook_a4_2:        overlayPathFlipbookA4Page2,
      overlay_path_flipbook_preview:     overlayPathFlipbookPreview,
      thumbnail_path:                    thumbnailPath,
      enabled:                           true,
      sort_order:                        nextOrder,
      version:                           1
    }).select().single();

    if (error) throw error;
    return data;
  },

  async _uploadFile(file, storagePath, mimeType) {
    const client = getSupabaseClient();
    const { error } = await client.storage.from(CLOUD_CONFIG.bucketName).upload(storagePath, file, {
      upsert: true,   // admin uploads use upsert:true (authenticated role has UPDATE permission)
      contentType: mimeType
    });
    if (error) throw error;
    return storagePath;
  },

  /*
   * Updates mutable template fields.
   * Bumps the version number on any file-changing fields so the kiosk
   * re-downloads the updated assets on next sync.
   */
  async updateTemplate(id, updates) {
    const client = getSupabaseClient();

    // If any overlay/thumbnail path changed, bump the version so kiosks re-download
    const bumpVersion = updates.overlay_path_2x6              || updates.overlay_path_4x6              ||
                        updates.overlay_path_long_duo         || updates.overlay_path_long_mini         ||
                        updates.overlay_path_film_duo         || updates.overlay_path_wide_mini         ||
                        updates.preview_overlay_path_long_duo || updates.preview_overlay_path_long_mini ||
                        updates.preview_overlay_path_film_duo || updates.preview_overlay_path_wide_mini ||
                        updates.overlay_path_flipbook_cover   || updates.overlay_path_flipbook_a4_1      ||
                        updates.overlay_path_flipbook_a4_2    || updates.overlay_path_flipbook_preview   ||
                        updates.thumbnail_path;
    if (bumpVersion) {
      // Fetch current version first
      const { data: current } = await client
        .from("templates")
        .select("version")
        .eq("id", id)
        .single();
      updates.version = ((current && current.version) || 1) + 1;
    }

    const { data, error } = await client
      .from("templates")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /*
   * Uploads a keychain overlay PNG and links it to the specified 2×6 template.
   * Parameters:
   *   templateId    — the id of the 2×6 template to link
   *   keychainFile  — File object (PNG) for the keychain overlay
   *
   * The keychain overlay is stored at:
   *   templates/<existing-prefix>/keychain_overlay.png
   *
   * Passing keychainFile = null clears the link (sets keychain_overlay_path to null).
   */
  async uploadKeychainOverlay(templateId, keychainFile) {
    const client = getSupabaseClient();

    // Fetch the template to derive the storage prefix from its existing overlay path
    const { data: current, error: fetchErr } = await client
      .from("templates")
      .select("overlay_path_2x6, overlay_path_4x6, thumbnail_path, version")
      .eq("id", templateId)
      .single();
    if (fetchErr) throw fetchErr;

    // Clear link if no file provided
    if (!keychainFile) {
      const { data, error } = await client
        .from("templates")
        .update({ keychain_overlay_path: null })
        .eq("id", templateId)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    // Derive storage prefix from existing paths
    let storagePrefix = null;
    if (current.overlay_path_2x6) {
      storagePrefix = current.overlay_path_2x6.replace(/\/overlay_2x6\.[^/]+$/, "");
    } else if (current.overlay_path_4x6) {
      storagePrefix = current.overlay_path_4x6.replace(/\/overlay_4x6\.[^/]+$/, "");
    } else if (current.thumbnail_path) {
      storagePrefix = current.thumbnail_path.replace(/\/thumbnail\.[^/]+$/, "");
    }
    if (!storagePrefix) {
      throw new Error("Cannot derive storage prefix — template has no existing overlay or thumbnail.");
    }

    const keychainPath = `${storagePrefix}/keychain_overlay.png`;
    await this._uploadFile(keychainFile, keychainPath, "image/png");

    // Bump version so kiosk re-downloads updated assets
    const newVersion = ((current.version) || 1) + 1;

    const { data, error } = await client
      .from("templates")
      .update({ keychain_overlay_path: keychainPath, version: newVersion })
      .eq("id", templateId)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /*
   * Reorders templates by assigning sort_order = array index.
   * ids — array of template IDs in the desired order.
   */
  async reorderTemplates(ids) {
    const client = getSupabaseClient();
    // Supabase JS doesn't support bulk update in one query without a trigger,
    // so we send them sequentially. For typical template counts (<50) this
    // is fast enough; a stored procedure could batch this if needed.
    for (let i = 0; i < ids.length; i++) {
      const { error } = await client
        .from("templates")
        .update({ sort_order: i })
        .eq("id", ids[i]);
      if (error) throw error;
    }
  },

  /*
   * Deletes a template: removes Supabase Storage files then the table row.
   */
  async deleteTemplate(id) {
    const client = getSupabaseClient();

    // Fetch the row first to know which storage paths to remove
    const { data: template, error: fetchError } = await client
      .from("templates")
      .select("*")
      .eq("id", id)
      .single();
    if (fetchError) throw fetchError;

    const pathsToRemove = [
      template.overlay_path_2x6,
      template.overlay_path_4x6,
      template.overlay_path_long_duo,
      template.overlay_path_long_mini,
      template.overlay_path_film_duo,
      template.overlay_path_wide_mini,
      template.preview_overlay_path_long_duo,
      template.preview_overlay_path_long_mini,
      template.preview_overlay_path_film_duo,
      template.preview_overlay_path_wide_mini,
      template.overlay_path_flipbook_cover,
      template.overlay_path_flipbook_a4_1,
      template.overlay_path_flipbook_a4_2,
      template.overlay_path_flipbook_preview,
      template.thumbnail_path
    ].filter(Boolean);

    if (pathsToRemove.length) {
      const { error: removeError } = await client.storage
        .from(CLOUD_CONFIG.bucketName)
        .remove(pathsToRemove);
      if (removeError) throw removeError;
    }

    const { error: deleteError } = await client
      .from("templates")
      .delete()
      .eq("id", id);
    if (deleteError) throw deleteError;
  }
};

/* ===========================================================
 * TEMPLATE & FILTER OFFLINE CACHE
 *
 * Persists the last successfully synced template list (and any
 * custom filter list) to IndexedDB so the kiosk can boot and
 * operate fully offline using cached data.
 *
 * Used by asset-sync.js:
 *   await templateCache.saveTemplates(templateRows)
 *   const rows = await templateCache.loadTemplates()   // null if never saved
 *   await templateCache.saveFilters(filterRows)
 *   const filters = await templateCache.loadFilters()  // null if never saved
 *
 * The cache is keyed by simple string keys ("templates", "filters")
 * in the "studrioAssets" IDB store, separate from the session queue.
 * =========================================================== */
const templateCache = (() => {
  const DB_NAME    = "studrioAssets";
  const DB_VERSION = 1;
  const STORE      = "cache";

  let _db = null;

  function _openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function _set(key, value) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readwrite");
      const st  = tx.objectStore(STORE);
      const req = st.put({ key, value, savedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function _get(key) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, "readonly");
      const st  = tx.objectStore(STORE);
      const req = st.get(key);
      req.onsuccess = (e) => resolve(e.target.result ? e.target.result.value : null);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  return {
    /*
     * Persist the full template list returned by Supabase after a
     * successful sync. Call this inside asset-sync.js after fetching.
     */
    async saveTemplates(rows) {
      try {
        await _set("templates", rows);
        console.info(`[templateCache] Saved ${rows.length} template(s) to local cache.`);
      } catch (err) {
        console.warn("[templateCache] Could not save templates:", err.message || err);
      }
    },

    /*
     * Load the last cached template list.
     * Returns the array, or null if the cache is empty (first ever run).
     */
    async loadTemplates() {
      try {
        return await _get("templates");
      } catch (err) {
        console.warn("[templateCache] Could not load templates:", err.message || err);
        return null;
      }
    },

    /*
     * Persist the active filter list (custom filters from admin panel,
     * or the built-in defaults if the admin hasn't configured any).
     */
    async saveFilters(rows) {
      try {
        await _set("filters", rows);
        console.info(`[templateCache] Saved ${rows.length} filter(s) to local cache.`);
      } catch (err) {
        console.warn("[templateCache] Could not save filters:", err.message || err);
      }
    },

    /*
     * Load the last cached filter list.
     * Returns the array, or null if the cache is empty.
     */
    async loadFilters() {
      try {
        return await _get("filters");
      } catch (err) {
        console.warn("[templateCache] Could not load filters:", err.message || err);
        return null;
      }
    }
  };
})();
