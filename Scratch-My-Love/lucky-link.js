/* Lucky Aileen on its own domain: answers the pages' window.claude.use("db") / use("user") from Supabase instead of
   Claude, with the same calls the game and console already make (doc/collection, get/set/update/add, orderBy/limit,
   onSnapshot). Loaded only by the GitHub copy; inside Claude, window.claude already exists and this file does nothing.
   Who may write what is decided by the database (setup.sql), never here. */
(() => {
  const CONFIG = {
    url: "https://qaheaieqhclnqzxjvvfz.supabase.co", // Supabase > Project Settings > API > Project URL
    key: "sb_publishable_DsT9043zZgLDZKbJ34pFTQ_7k1ZzOr3", // the anon / publishable key (safe to publish; the database rules do the locking)
    emails: { lt: "lt@sensorylao.love", aileen: "aileen@sensorylao.love" },
  };
  if (window.claude || !window.supabase || !CONFIG.url || !CONFIG.key) return;

  const sb = window.supabase.createClient(CONFIG.url, CONFIG.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "lucky-aileen.auth" },
  });
  const TABLE = "lucky_docs", POLL_MS = 4000;
  let role = null, uid = null;

  async function loadRole() {
    const { data } = await sb.auth.getSession();
    uid = data.session ? data.session.user.id : null;
    if (!uid) return (role = null);
    const r = await sb.rpc("lucky_role");
    return (role = r.error ? null : r.data || null);
  }
  const ready = loadRole().catch(() => (role = null));

  const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
  const fail = (error) => { const e = new Error(error.message || "Request failed"); e.code = error.code; throw e; };
  const docSnap = (id, row) => ({ id, exists: !!row, data: () => (row ? plain(row.data) : undefined) });
  const querySnap = (rows) => {
    const docs = rows.map((r) => ({ id: r.id, exists: true, data: () => plain(r.data) }));
    return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
  };

  /* Live updates by polling: cheap at this size, and it survives flaky wifi with no setup on the database side. */
  const watchers = new Set();
  function watch(fetch, toSnap, onNext, onError) {
    const w = {
      last: undefined, reported: false,
      async run() {
        let res;
        try { res = await fetch(); } catch (e) { return; } // offline: keep the last picture and try again
        if (res.error) {
          // A refusal from the server is reported once; a dropped connection (no code) just waits for the next poll.
          if (res.error.code && !w.reported && typeof onError === "function") { w.reported = true; onError(res.error); }
          return;
        }
        const key = JSON.stringify(res.data);
        if (key === w.last) return;
        w.last = key;
        onNext(toSnap(res.data));
      },
    };
    watchers.add(w);
    w.run();
    return () => watchers.delete(w);
  }
  const refresh = () => watchers.forEach((w) => w.run());
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  function docRef(collection, id) {
    const one = () => sb.from(TABLE).select("id,data").eq("collection", collection).eq("id", id).maybeSingle();
    return {
      id,
      async get() { const r = await one(); if (r.error) fail(r.error); return docSnap(id, r.data); },
      async set(value) {
        const r = await sb.from(TABLE).upsert({ collection, id, data: plain(value), updated_at: new Date().toISOString() });
        if (r.error) fail(r.error);
        refresh();
      },
      async update(patch) {
        const r = await sb.rpc("lucky_patch", { p_collection: collection, p_id: id, p_patch: plain(patch) });
        if (r.error) fail(r.error);
        if (!r.data) fail({ message: "That item no longer exists.", code: "not_found" });
        refresh();
      },
      async delete() { const r = await sb.from(TABLE).delete().eq("collection", collection).eq("id", id); if (r.error) fail(r.error); refresh(); },
      onSnapshot(onNext, onError) { return watch(one, (row) => docSnap(id, row), onNext, onError); },
    };
  }

  function query(collection, order, max) {
    const run = () => {
      let q = sb.from(TABLE).select("id,data").eq("collection", collection);
      q = order ? q.order("data->" + order.field, { ascending: order.dir !== "desc" }) : q.order("created_at", { ascending: true });
      return max ? q.limit(max) : q;
    };
    return {
      orderBy: (field, dir) => query(collection, { field: String(field).replace(/[^\w]/g, ""), dir }, max),
      limit: (n) => query(collection, order, Math.max(1, Math.trunc(n) || 1)),
      async get() { const r = await run(); if (r.error) fail(r.error); return querySnap(r.data || []); },
      onSnapshot(onNext, onError) { return watch(run, (rows) => querySnap(rows || []), onNext, onError); },
    };
  }

  const db = {
    doc(path) { const [c, id] = String(path).split("/"); return docRef(c, id); },
    collection(name) {
      return Object.assign(query(name), {
        doc: (id) => docRef(name, id),
        async add(value) {
          const id = crypto.randomUUID();
          const r = await sb.from(TABLE).insert({ collection: name, id, data: plain(value) });
          if (r.error) fail(r.error);
          refresh();
          return { id };
        },
      });
    },
  };
  const user = {
    isOwner: async () => role === "lt",
    canEdit: async () => role === "lt",
    can: async () => !!role,
    id: async () => uid,
  };

  window.claude = Object.freeze({
    async use(name) {
      await ready;
      if (!role) return null;
      return name === "db" ? db : name === "user" ? user : null;
    },
  });

  /* The game's login screen signs in through here. Messages are the ones shown under the password box. */
  window.LUCKY_HOSTED = Object.freeze({
    async signIn(who, password) {
      const email = CONFIG.emails[who];
      if (!email) return { ok: false, message: "Pick who's playing first." };
      let res;
      try { res = await sb.auth.signInWithPassword({ email, password }); }
      catch (e) { return { ok: false, message: "Couldn't reach the game. Check the connection and try again." }; }
      if (res.error) {
        const offline = !res.error.status || res.error.name === "AuthRetryableFetchError";
        return { ok: false, message: offline ? "Couldn't reach the game. Check the connection and try again." : "Wrong password." };
      }
      await loadRole().catch(() => (role = null));
      if (role !== who) {
        await sb.auth.signOut().catch(() => {});
        role = null;
        return { ok: false, message: "This login isn't linked to the game yet." };
      }
      return { ok: true, role };
    },
    async signOut() { await sb.auth.signOut().catch(() => {}); role = null; uid = null; },
  });
})();
