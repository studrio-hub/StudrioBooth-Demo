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

const CLOUD_CONFIG = {
  enabled: true,
  supabaseUrl: "https://oismyjlhnlfavrdfvabg.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pc215amxobmxmYXZyZGZ2YWJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTI3OTMsImV4cCI6MjEwMDU4ODc5M30.TLGFzBFDYJsWUErTVV8yP2SlpkL9LzEPoFKV2R3hBGE",
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

const cloudStorage = {
  isAvailable() {
    return CLOUD_CONFIG.enabled && typeof supabase !== "undefined"
      && !!CLOUD_CONFIG.supabaseUrl && !!CLOUD_CONFIG.supabaseAnonKey;
  },

  async uploadBlob(blob, path, { retries = 2, retryDelayMs = 1500 } = {}) {
    const client = getSupabaseClient();
    // upsert is intentionally false — every session has a unique ID so paths
    // are never reused. upsert:true internally requires UPDATE permission on
    // storage.objects which the anon role does not have.
    //
    // Retry loop: ERR_HTTP2_PROTOCOL_ERROR and transient Supabase connection
    // resets (common after large canvas exports stall the HTTP/2 connection)
    // are almost always resolved by a single retry. We wait retryDelayMs
    // between attempts to give the connection time to recover.
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        console.warn(`[cloudStorage] uploadBlob retry ${attempt}/${retries} for ${path} after: ${lastError && lastError.message || lastError}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
      const { error } = await client.storage.from(CLOUD_CONFIG.bucketName).upload(path, blob, {
        upsert: false,
        contentType: blob.type || "application/octet-stream"
      });
      if (!error) {
        const { data } = client.storage.from(CLOUD_CONFIG.bucketName).getPublicUrl(path);
        return data.publicUrl;
      }
      lastError = error;
    }
    throw lastError;
  },

  async saveSession(sessionData) {
    const prefix = `sessions/${sessionData.id}`;

    // Upload strip, video, and print-ready PNG in parallel rather than
    // sequentially. This halves total upload time on typical connections and
    // avoids HTTP/2 connection staleness that can accumulate when individual
    // uploads are queued back-to-back after a long canvas/video export phase.
    const [finalStripUrl, finalStripVideoUrl, printReadyUrl] = await Promise.all([
      sessionData.finalStripPng
        ? this.uploadBlob(sessionData.finalStripPng, `${prefix}/strip.png`)
        : Promise.resolve(null),
      sessionData.finalStripVideo
        ? this.uploadBlob(sessionData.finalStripVideo, `${prefix}/strip-live.${videoExtensionFor(sessionData.finalStripVideo)}`)
        : Promise.resolve(null),
      sessionData.printReadyPng
        ? this.uploadBlob(sessionData.printReadyPng, `${prefix}/strip-print.png`)
        : Promise.resolve(null)
    ]);

    const sessionJson = {
      id: sessionData.id,
      frameType: sessionData.frameType,
      design: sessionData.design,
      stripPath:       finalStripUrl      ? `${prefix}/strip.png`                                                        : null,
      stripVideoPath:  finalStripVideoUrl ? `${prefix}/strip-live.${videoExtensionFor(sessionData.finalStripVideo)}`     : null,
      printReadyPath:  printReadyUrl      ? `${prefix}/strip-print.png`                                                  : null,
      createdAt: new Date().toISOString()
    };

    const jsonBlob = new Blob([JSON.stringify(sessionJson)], { type: "application/json" });
    await this.uploadBlob(jsonBlob, `${prefix}/session.json`);

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
      if (error) throw error;
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

    async function sign(path) {
      if (!path) return null;
      const { data, error } = await client.storage
        .from(CLOUD_CONFIG.bucketName)
        .createSignedUrl(path, 3600);
      if (error) { console.warn("[cloudStorage] Could not sign URL for", path, error.message); return null; }
      return data.signedUrl;
    }

    function isPath(v) { return v && v.startsWith("sessions/"); }

    const [finalStripUrl, finalStripVideoUrl] = await Promise.all([
      isPath(session.stripPath)      ? sign(session.stripPath)      : (session.finalStripUrl || null),
      isPath(session.stripVideoPath) ? sign(session.stripVideoPath) : (session.finalStripVideoUrl || null)
    ]);

    return {
      id: session.id,
      frameType: session.frameType,
      design: session.design,
      finalStripUrl,
      finalStripVideoUrl,
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
  }
};

/* ===========================================================
 * ADMIN-ONLY FUNCTIONS — used exclusively by admin pages.
 * Relies on an authenticated Supabase session; RLS policies
 * in supabase-templates-setup.sql reject anonymous callers.
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
      thumbnail_url:    t.thumbnail_path    ? this._publicUrl(t.thumbnail_path)    : null,
      overlay_url_2x6:  t.overlay_path_2x6  ? this._publicUrl(t.overlay_path_2x6)  : null,
      overlay_url_4x6:  t.overlay_path_4x6  ? this._publicUrl(t.overlay_path_4x6)  : null
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
   *   name        — display name (string)
   *   assetType   — "frame_template" | "sticker" | "background" | "gif_video" | "logo"
   *   file2x6     — File object for the 2×6 overlay PNG (or null)
   *   file4x6     — File object for the 4×6 overlay PNG (or null)
   *   thumbFile   — File object for the thumbnail image (or null)
   *
   * Storage layout in the photobooth bucket:
   *   templates/<slug>/overlay_2x6.png
   *   templates/<slug>/overlay_4x6.png
   *   templates/<slug>/thumbnail.png
   */
  async uploadTemplate({ name, assetType, file2x6, file4x6, thumbFile }) {
    const client = getSupabaseClient();

    // Derive a URL-safe slug from the name for the storage prefix
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 48);
    // Append a short timestamp to avoid collisions on same-name uploads
    const prefix = `templates/${slug}-${Date.now()}`;

    const [overlayPath2x6, overlayPath4x6, thumbnailPath] = await Promise.all([
      file2x6    ? this._uploadFile(file2x6,    `${prefix}/overlay_2x6.png`, "image/png") : Promise.resolve(null),
      file4x6    ? this._uploadFile(file4x6,    `${prefix}/overlay_4x6.png`, "image/png") : Promise.resolve(null),
      thumbFile  ? this._uploadFile(thumbFile,  `${prefix}/thumbnail.png`,   thumbFile.type || "image/png") : Promise.resolve(null)
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
      asset_type:       assetType || "frame_template",
      overlay_path_2x6: overlayPath2x6,
      overlay_path_4x6: overlayPath4x6,
      thumbnail_path:   thumbnailPath,
      enabled:          true,
      sort_order:       nextOrder,
      version:          1
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

    // If any overlay/thumbnail path changed, bump the version
    const bumpVersion = updates.overlay_path_2x6 || updates.overlay_path_4x6 || updates.thumbnail_path;
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
