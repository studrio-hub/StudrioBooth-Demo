/*
 * CLOUD-STORAGE.JS — Supabase Storage backend (free tier, no card required).
 *
 * TO ENABLE:
 * 1. Create a free project at supabase.com (no card needed).
 * 2. Storage → New bucket → name it "photobooth" → toggle Public ON.
 * 3. Project Settings → API → copy "Project URL" and "anon public" key
 *    into CLOUD_CONFIG below.
 * 4. Set CLOUD_CONFIG.enabled = true.
 *
 * Session metadata (frameType, design, media URLs) is stored as a
 * small session.json file inside the same public bucket — no separate
 * database table needed. Until enabled, the app automatically keeps
 * using local-only IndexedDB storage (same-device preview).
 */

const CLOUD_CONFIG = {
  enabled: true, // flip to true once the values below are filled in
  supabaseUrl: "https://oismyjlhnlfavrdfvabg.supabase.co",      // e.g. "https://xxxxx.supabase.co"
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pc215amxobmxmYXZyZGZ2YWJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTI3OTMsImV4cCI6MjEwMDU4ODc5M30.TLGFzBFDYJsWUErTVV8yP2SlpkL9LzEPoFKV2R3hBGE",  // the "anon public" key from Project Settings → API
  bucketName: "photobooth"
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

// Recording now prefers MP4 when the browser supports it (see camera-bridge.js
// / strip.js) — this makes sure the uploaded filename's extension always
// matches what was actually recorded, instead of assuming WebM.
function videoExtensionFor(blob) {
  return blob && blob.type && blob.type.includes("mp4") ? "mp4" : "webm";
}

const cloudStorage = {
  isAvailable() {
    return CLOUD_CONFIG.enabled && typeof supabase !== "undefined"
      && !!CLOUD_CONFIG.supabaseUrl && !!CLOUD_CONFIG.supabaseAnonKey;
  },

  async uploadBlob(blob, path) {
    const client = getSupabaseClient();
    const { error } = await client.storage.from(CLOUD_CONFIG.bucketName).upload(path, blob, {
      upsert: true,
      contentType: blob.type || "application/octet-stream"
    });
    if (error) throw error;
    const { data } = client.storage.from(CLOUD_CONFIG.bucketName).getPublicUrl(path);
    return data.publicUrl;
  },

    async saveSession(sessionData) {
    const uploadedPhotos = await Promise.all(
      sessionData.photos.map(async (p, i) => {
        const imageUrl = p.image ? await this.uploadBlob(p.image, `sessions/${sessionData.id}/photo-${i}.jpg`) : null;
        const videoUrl = p.video ? await this.uploadBlob(p.video, `sessions/${sessionData.id}/video-${i}.${videoExtensionFor(p.video)}`) : null;
        return { id: p.id, imageUrl, videoUrl };
      })
    );

    const finalStripUrl = sessionData.finalStripPng
      ? await this.uploadBlob(sessionData.finalStripPng, `sessions/${sessionData.id}/strip.png`)
      : null;

    const finalStripVideoUrl = sessionData.finalStripVideo
      ? await this.uploadBlob(sessionData.finalStripVideo, `sessions/${sessionData.id}/strip-live.${videoExtensionFor(sessionData.finalStripVideo)}`)
      : null;

    // QR-baked, print-ready copy — same file format used for physical
    // printing (see printing.js) — stored so the admin dashboard can
    // always hand out a reprint-ready file, even for sessions the guest
    // never actually sent to the printer.
    const printReadyUrl = sessionData.printReadyPng
      ? await this.uploadBlob(sessionData.printReadyPng, `sessions/${sessionData.id}/strip-print.png`)
      : null;

    const sessionJson = {
      id: sessionData.id,
      frameType: sessionData.frameType,
      design: sessionData.design,
      photos: uploadedPhotos,
      finalStripUrl,
      finalStripVideoUrl,
      printReadyUrl,
      createdAt: new Date().toISOString()
    };

    const jsonBlob = new Blob([JSON.stringify(sessionJson)], { type: "application/json" });
    await this.uploadBlob(jsonBlob, `sessions/${sessionData.id}/session.json`);

    // Mirror into the `sessions` table (see supabase-admin-setup.sql) so
    // the admin dashboard can list/delete/count sessions without having
    // to crawl storage folders. Best-effort: if this fails, the guest
    // gallery still works fine off session.json above — only the admin
    // dashboard listing would miss this one entry.
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
      if (error) throw error; // insert() doesn't throw on RLS/API errors on its own — must check explicitly
    } catch (e) {
      console.error("[cloudStorage] Could not mirror session into sessions table:", e.message || e);
    }

    return { url: `${window.location.origin}${window.location.pathname.replace("index.html", "")}gallery.html?gallery=${sessionData.id}` };
  },

  async getSession(sessionId) {
    const client = getSupabaseClient();
    const { data } = client.storage.from(CLOUD_CONFIG.bucketName).getPublicUrl(`sessions/${sessionId}/session.json`);
    const res = await fetch(`${data.publicUrl}?t=${Date.now()}`); // cache-bust
    if (!res.ok) return null;
    return res.json();
  },

  /* Called by the kiosk (printing.js) each time a print job actually
     fires — logs one row per print job so "copies printed" is a real
     sum, not a counter that can drift. Anon-insert-only, see SQL setup. */
  async logPrintEvent(sessionId, quantity) {
    try {
      const client = getSupabaseClient();
      const { error } = await client.from("print_events").insert({ session_id: sessionId, quantity: quantity || 1 });
      if (error) throw error;
    } catch (e) {
      console.error("[cloudStorage] Could not log print event:", e.message || e);
    }
  }
};

/* ===========================================================
 * ADMIN-ONLY FUNCTIONS — used exclusively by admin.html/admin.js.
 * Everything here relies on an authenticated Supabase session; the
 * RLS policies in supabase-admin-setup.sql reject these calls for
 * anonymous (kiosk) callers.
 * =========================================================== */
const adminStorage = {
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

  /* All sessions, newest first — powers the dashboard's gallery grid. */
  async listAllSessions() {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("sessions")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  },

  /* Deletes a session's files from storage AND its table rows.
     Files are removed first — if that fails, the row is kept so the
     dashboard doesn't lose track of an orphaned-but-still-present set
     of files. */
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

  /* Photostrips taken, total copies printed, and total storage bytes
     used — for the dashboard's stats panel. Storage usage is computed
     by walking every session's folder and summing file sizes; fine at
     kiosk-event scale (dozens–low hundreds of sessions), but if this
     ever needs to scale to thousands of sessions, move this to a
     Postgres function reading storage.objects metadata instead. */
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
      if (error) continue; // skip a folder we can't read rather than fail the whole stats call
      totalBytes += (files || []).reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
    }

    return {
      photostripCount: photostripCount || 0,
      totalCopiesPrinted,
      totalStorageBytes: totalBytes
    };
  }
};