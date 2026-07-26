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
        const videoUrl = p.video ? await this.uploadBlob(p.video, `sessions/${sessionData.id}/video-${i}.webm`) : null;
        return { id: p.id, imageUrl, videoUrl };
      })
    );

    const finalStripUrl = sessionData.finalStripPng
      ? await this.uploadBlob(sessionData.finalStripPng, `sessions/${sessionData.id}/strip.png`)
      : null;

    const finalStripVideoUrl = sessionData.finalStripVideo
      ? await this.uploadBlob(sessionData.finalStripVideo, `sessions/${sessionData.id}/strip-live.webm`)
      : null;

    const sessionJson = {
      id: sessionData.id,
      frameType: sessionData.frameType,
      design: sessionData.design,
      photos: uploadedPhotos,
      finalStripUrl,
      finalStripVideoUrl,
      createdAt: new Date().toISOString()
    };

    const jsonBlob = new Blob([JSON.stringify(sessionJson)], { type: "application/json" });
    await this.uploadBlob(jsonBlob, `sessions/${sessionData.id}/session.json`);

    return { url: `${window.location.origin}${window.location.pathname.replace("index.html", "")}gallery.html?gallery=${sessionData.id}&cloud=1` };
  },

  async getSession(sessionId) {
    const client = getSupabaseClient();
    const { data } = client.storage.from(CLOUD_CONFIG.bucketName).getPublicUrl(`sessions/${sessionId}/session.json`);
    const res = await fetch(`${data.publicUrl}?t=${Date.now()}`); // cache-bust
    if (!res.ok) return null;
    return res.json();
  }
};