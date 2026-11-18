"use strict";
/* 私の本棚 — データはこの端末のブラウザ（localStorage）に保存します */

const STATUSES = ["未読", "読書中", "読了"];
const STORE_KEY = "hondana.v1";
const PREF_KEY = "hondana.prefs";
const FIELDS = [
  ["title", "タイトル", "full"], ["author", "著者", "full"], ["publisher", "出版社", ""], ["label", "レーベル", ""],
  ["series", "シリーズ", ""], ["volume", "巻", ""], ["isbn", "ISBN", ""], ["releaseDate", "発売日", ""],
  ["location", "置き場所", ""], ["genres", "ジャンル", ""], ["memo", "メモ", "full"],
];
const CSV_COLS = ["id", "title", "author", "publisher", "label", "series", "volume", "isbn", "releaseDate", "status", "location", "genres", "memo", "cover", "addedAt"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/* ---------- storage ---------- */
const DB = {
  books: new Map(),
  meta: { lastBackup: 0, lastNudge: 0 },
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (raw) {
        this.books = new Map(Object.entries(raw.books || {}));
        this.meta = Object.assign(this.meta, raw.meta || {});
      }
    } catch (e) { console.error(e); }
  },
  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ books: Object.fromEntries(this.books), meta: this.meta }));
      return true;
    } catch (e) {
      toast("保存できませんでした。端末の空き容量を確認してください");
      return false;
    }
  },
  put(id, book) { this.books.set(id, book); this.save(); },
  remove(id) { this.books.delete(id); this.save(); },
  nextId() {
    let m = 0;
    for (const id of this.books.keys()) { const n = /^BOOK-(\d+)$/.exec(id); if (n) m = Math.max(m, +n[1]); }
    return "BOOK-" + String(m + 1).padStart(4, "0");
  },
  findByIsbn(isbn) { for (const [id, b] of this.books) if (b.isbn === isbn) return id; return null; },
};

const S = { filter: "all", q: "", sort: "added", group: false, editing: null };
try { Object.assign(S, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch (e) {}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ filter: S.filter, sort: S.sort, group: S.group })); } catch (e) {} }

/* ---------- toast / busy ---------- */
let toastT;
function toast(msg, ms = 3200) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
function busy(on, text) { $("busy").hidden = !on; if (text) $("busyText").textContent = text; }

/* ---------- ISBN ---------- */
function isbn13ok(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0; for (let i = 0; i < 12; i++) sum += (+s[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +s[12];
}
function toIsbn13(raw) {
  let s = String(raw || "").normalize("NFKC").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (s.length === 10) {
    const b = "978" + s.slice(0, 9); let sum = 0;
    for (let i = 0; i < 12; i++) sum += (+b[i]) * (i % 2 ? 3 : 1);
    s = b + ((10 - (sum % 10)) % 10);
  }
  return isbn13ok(s) ? s : null;
}
function guessPublisher(isbn) {
  if (!isbn) return "";
  let best = 0, pubs = new Set();
  for (const b of DB.books.values()) {
    if (!b.isbn || !b.publisher) continue;
    let k = 0; while (k < 12 && b.isbn[k] === isbn[k]) k++;
    if (k > best) { best = k; pubs = new Set([b.publisher]); } else if (k === best) pubs.add(b.publisher);
  }
  if (best < 6) return "";
  if (best === 6) {
    const all = new Set([...DB.books.values()].filter((b) => b.isbn && b.isbn.startsWith(isbn.slice(0, 6))).map((b) => b.publisher));
    return all.size === 1 ? [...all][0] : "";
  }
  return pubs.size === 1 ? [...pubs][0] : "";
}

/* ---------- 書誌情報の取得 (openBD → Google Books) ---------- */
async function fetchJson(url, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
function fmtDate(s) {
  s = String(s || "").replace(/[^0-9]/g, "");
  if (s.length >= 8) return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
  if (s.length === 6) return `${s.slice(0, 4)}/${s.slice(4, 6)}`;
  return s.slice(0, 4);
}
function fromOpenBD(item) {
  const s = item && item.summary; if (!s || !s.title) return null;
  let title = s.title.trim();
  if (s.volume && !title.includes(s.volume)) title += " " + s.volume;
  const author = String(s.author || "").replace(/／[^\s]*/g, "").trim().split(/\s+/).filter(Boolean).join("、");
  let label = "";
  try {
    const col = item.onix.DescriptiveDetail.Collection;
    label = col?.TitleDetail?.TitleElement?.find?.((e) => e.CollectionSequence == null)?.TitleText?.content || col?.TitleDetail?.TitleElement?.[0]?.TitleText?.content || "";
  } catch (e) {}
  return { title, author, publisher: s.publisher || "", series: s.series || "", volume: String(s.volume || "").replace(/[^0-9]/g, ""), releaseDate: fmtDate(s.pubdate), cover: s.cover || "", label, source: "openBD" };
}
async function lookup(isbn) {
  try {
    const j = await fetchJson(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
    const r = fromOpenBD(j && j[0]); if (r) return r;
  } catch (e) {}
  try {
    const j = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = j.items && j.items[0] && j.items[0].volumeInfo;
    if (v && v.title) {
      return {
        title: v.title + (v.subtitle ? " " + v.subtitle : ""), author: (v.authors || []).join("、"), publisher: v.publisher || "",
        releaseDate: fmtDate(v.publishedDate), cover: (v.imageLinks?.thumbnail || "").replace(/^http:/, "https:"),
        series: "", volume: "", label: "", source: "Google Books",
      };
    }
  } catch (e) {}
  return null;
}

/* ---------- list ---------- */
function seriesKey(b) {
  if (b.series) return norm(b.series);
  return norm(String(b.title).replace(/[（(〈＜<\[【]?\s*(第)?[0-9０-９上中下]+\s*(巻)?\s*[）)〉＞>\]】]?.*$/, "").replace(/\s+[0-9０-９]+\s*$/, ""));
}
function seriesName(b) { return b.series || String(b.title).replace(/[（(].*$/, "").replace(/\s+[0-9０-９]+\s*$/, ""); }
function sorter(a, b) {
  if (S.sort === "added") return (b.addedAt || 0) - (a.addedAt || 0);
  const k = S.sort, ka = String(a[k] || "￿"), kb = String(b[k] || "￿");
  return ka.localeCompare(kb, "ja", { numeric: true }) || String(a.title).localeCompare(String(b.title), "ja", { numeric: true });
}
function coverOrSpine(b) {
  return b.cover ? `<img class="cover" src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'spine s-${esc(b.status)}'}))">`
    : `<span class="spine s-${esc(b.status)}"></span>`;
}
function rowHtml(b) {
  return `<li><button class="row" data-id="${esc(b.id)}">${coverOrSpine(b)}<span class="main"><div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || "著者未登録")}${b.publisher ? " · " + esc(b.publisher) : ""}</div></span><span class="pill s-${esc(b.status)}">${esc(b.status)}</span></button></li>`;
}
function render() {
  const all = [...DB.books.entries()].map(([id, b]) => ({ id, ...b }));
  const counts = { all: all.length }; STATUSES.forEach((s) => (counts[s] = all.filter((b) => b.status === s).length));
  $("count").innerHTML = `<b>${counts.all}</b> 冊`;
  $("chips").innerHTML = [["all", "すべて"], ...STATUSES.map((s) => [s, s])].map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${S.filter === k}">${l} ${counts[k]}</button>`).join("");
  const q = norm(S.q);
  const rows = all.filter((b) => (S.filter === "all" || b.status === S.filter) && (!q || norm([b.title, b.author, b.publisher, b.series, b.label, b.isbn, b.memo, b.location].join(" ")).includes(q)));
  rows.sort(sorter);
  const list = $("list"), empty = $("empty");
  if (!all.length) {
    empty.hidden = false; list.innerHTML = "";
    empty.innerHTML = `<h2>本棚はまだ空です</h2><p>下の「バーコードで追加」から登録するか、<br>バックアップファイルから取り込めます。</p><button class="btn" id="emptyImport">ファイルから取り込む</button>`;
    $("emptyImport").onclick = () => $("importInput").click();
    return;
  }
  if (!rows.length) { empty.hidden = false; empty.innerHTML = `<h2>見つかりませんでした</h2><p>検索語や絞り込みを変えてみてください。</p>`; list.innerHTML = ""; return; }
  empty.hidden = true;
  if (S.group) {
    const groups = new Map();
    for (const b of rows) { const k = seriesKey(b); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
    list.innerHTML = [...groups.values()].map((g) => {
      if (g.length === 1) return rowHtml(g[0]);
      const n = g.length, d = g.filter((b) => b.status === "読了").length, r = g.filter((b) => b.status === "読書中").length;
      const c = g.find((b) => b.cover);
      const lead = c ? `<img class="cover" src="${esc(c.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="spine ${d === n ? "s-読了" : r ? "s-読書中" : ""}"></span>`;
      return `<li><button class="row" data-series="${esc(seriesKey(g[0]))}">${lead}<span class="main"><div class="t">${esc(seriesName(g[0]))}</div><div class="a">${esc(g[0].author)}${g[0].publisher ? " · " + esc(g[0].publisher) : ""}</div><div class="bar"><i style="width:${(d / n) * 100}%;background:var(--done)"></i><i style="width:${(r / n) * 100}%;background:var(--reading)"></i></div></span><span class="series-meta"><b>${n}冊</b>読了 ${d}</span></button></li>`;
    }).join("");
  } else list.innerHTML = rows.map(rowHtml).join("");
}
$("sort").value = S.sort; $("groupToggle").checked = S.group;
$("chips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; S.filter = c.dataset.f; savePrefs(); render(); });
$("q").addEventListener("input", (e) => { S.q = e.target.value; render(); });
$("sort").addEventListener("change", (e) => { S.sort = e.target.value; savePrefs(); render(); });
$("groupToggle").addEventListener("change", (e) => { S.group = e.target.checked; savePrefs(); render(); });
$("list").addEventListener("click", (e) => {
  const r = e.target.closest(".row"); if (!r) return;
  if (r.dataset.id) openDetail(r.dataset.id);
  else if (r.dataset.series) {
    const first = [...DB.books.values()].find((b) => seriesKey(b) === r.dataset.series);
    S.group = false; $("groupToggle").checked = false; S.q = first ? seriesName(first) : ""; $("q").value = S.q;
    S.sort = "title"; $("sort").value = "title"; savePrefs(); render(); window.scrollTo(0, 0);
  }
});

/* ---------- sheet ---------- */
function openSheet(html) { const s = $("sheet"); s.innerHTML = `<div class="grip"></div>` + html; s.hidden = false; $("veil").hidden = false; s.scrollTop = 0; }
function closeSheet() { $("sheet").hidden = true; $("veil").hidden = true; S.editing = null; }
$("veil").addEventListener("click", closeSheet);

function formHtml(b) {
  return `<div class="seg" role="group" aria-label="読書状況">${STATUSES.map((s) => `<button type="button" class="s-${s}" data-st="${s}" aria-pressed="${b.status === s}">${s}</button>`).join("")}</div>
  <div class="form">${FIELDS.map(([k, l, c]) => `<div class="f ${c}"><label for="f-${k}">${l}</label>${k === "memo" ? `<textarea id="f-${k}">${esc(b[k])}</textarea>` : `<input id="f-${k}" value="${esc(b[k])}"${k === "isbn" || k === "volume" ? ' inputmode="numeric"' : ""}>`}</div>`).join("")}</div>`;
}
function readForm() {
  const o = {}; FIELDS.forEach(([k]) => (o[k] = $("f-" + k).value.trim()));
  o.status = $("sheet").querySelector('.seg [aria-pressed="true"]')?.dataset.st || "未読";
  return o;
}
function bindSeg() {
  $("sheet").querySelector(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("sheet").querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  });
}
function headHtml(b, title) {
  return `<div class="head">${b.cover ? `<img src="${esc(b.cover)}" alt="" referrerpolicy="no-referrer">` : ""}<div class="main"><h2>${esc(title || b.title)}</h2><p class="sub">${esc(b.author || "")}${b.publisher ? " · " + esc(b.publisher) : ""}</p></div></div>`;
}
function openDetail(id, notice) {
  const b = DB.books.get(id); if (!b) return; S.editing = id;
  openSheet(`${notice ? `<p class="notice">${esc(notice)}</p>` : ""}${headHtml(b)}${formHtml(b)}
  <div class="actions"><button class="btn danger" id="delBtn">削除</button><button class="btn primary" id="saveBtn">保存</button></div>`);
  bindSeg();
  $("saveBtn").onclick = () => saveForm(id);
  $("delBtn").onclick = () => confirmDelete(id);
}
function confirmDelete(id) {
  const b = DB.books.get(id);
  openSheet(`<h2>この本を削除しますか？</h2><p class="sub">「${esc(b.title)}」を本棚から消します。元に戻せません。</p>
  <div class="actions"><button class="btn" id="cancelDel">やめる</button><button class="btn danger-fill" id="doDel">削除する</button></div>`);
  $("cancelDel").onclick = () => openDetail(id);
  $("doDel").onclick = () => { DB.remove(id); closeSheet(); render(); toast("削除しました"); };
}
function openNew(prefill = {}, notice) {
  const b = { status: "未読", title: "", author: "", publisher: "", label: "", series: "", volume: "", isbn: "", releaseDate: "", location: "", genres: "", memo: "", cover: "", ...prefill };
  S.editing = "__new"; S.newCover = b.cover || "";
  openSheet(`${notice ? `<p class="notice ${notice.warn ? "warn" : ""}">${esc(notice.text)}</p>` : ""}${b.title ? headHtml(b, "本を追加") : `<h2>本を追加</h2><p class="sub">ISBNを入れて「調べる」を押すと自動入力します</p>`}
  <div class="actions" style="margin:0 0 12px"><button class="btn" id="lookupBtn">ISBNで調べる</button></div>
  ${formHtml(b)}
  <div class="actions"><button class="btn" id="cancelNew">キャンセル</button><button class="btn primary" id="saveBtn">本棚に追加</button></div>`);
  bindSeg();
  $("cancelNew").onclick = closeSheet;
  $("saveBtn").onclick = () => saveForm(null);
  $("lookupBtn").onclick = async () => {
    const isbn = toIsbn13($("f-isbn").value); if (!isbn) { toast("ISBNを正しく入力してください（978から始まる13桁）"); return; }
    const dup = DB.findByIsbn(isbn); if (dup) { openDetail(dup, "このISBNの本はすでに本棚にあります。"); return; }
    busy(true, "調べています…"); const info = await lookup(isbn); busy(false);
    if (!info) { toast("見つかりませんでした。手入力してください"); return; }
    const cur = readForm();
    for (const k of ["title", "author", "publisher", "label", "series", "volume", "releaseDate"]) if (!cur[k] && info[k]) cur[k] = info[k];
    openNew({ ...cur, isbn, cover: info.cover }, { text: `${info.source} から入力しました。内容を確認してください。` });
  };
}
function saveForm(id) {
  const o = readForm();
  if (!o.title) { toast("タイトルを入力してください"); $("f-title").focus(); return; }
  if (o.isbn) {
    const i = toIsbn13(o.isbn); if (!i) { toast("ISBNが正しくありません。13桁の数字を確認してください"); return; }
    o.isbn = i;
    const dup = DB.findByIsbn(i); if (dup && dup !== id) { openDetail(dup, "このISBNの本はすでに本棚にあります。"); return; }
  }
  const now = Date.now();
  if (id) { DB.put(id, { ...DB.books.get(id), ...o, updatedAt: now }); toast("保存しました"); }
  else { if (!o.publisher && o.isbn) o.publisher = guessPublisher(o.isbn); DB.put(DB.nextId(), { ...o, cover: S.newCover || "", format: "紙", addedAt: now, updatedAt: now }); toast(`「${o.title}」を追加しました`); }
  closeSheet(); render();
}
function addBook(info, status) {
  const now = Date.now(), id = DB.nextId();
  DB.put(id, { title: info.title, author: info.author || "", publisher: info.publisher || guessPublisher(info.isbn), label: info.label || "", series: info.series || "", volume: info.volume || "", isbn: info.isbn, releaseDate: info.releaseDate || "", location: "", genres: "", memo: "", cover: info.cover || "", status, format: "紙", addedAt: now, updatedAt: now });
  return id;
}

/* ---------- barcode: live camera ---------- */
const SC = { stream: null, timer: 0, paused: false, last: "", lastAt: 0, added: 0, detector: null, zx: null, canvas: document.createElement("canvas") };
function zxReader() {
  if (SC.zx || !window.ZXing) return SC.zx;
  const Z = window.ZXing, hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  SC.zx = new Z.MultiFormatReader(); SC.zx.setHints(hints);
  return SC.zx;
}
function zxDecodeCanvas(c) {
  const Z = window.ZXing, r = zxReader(); if (!r) return null;
  try { return r.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)))).getText(); }
  catch (e) { return null; } finally { r.reset(); }
}
async function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { $("photoInput").click(); return; }
  $("scanner").hidden = false; $("scanCard").hidden = true; SC.paused = false; SC.added = 0; updateScanCount();
  $("scanHint").textContent = "裏表紙の上側のバーコード（978…）を枠に合わせてください";
  try {
    SC.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    closeScanner();
    toast("カメラを使えませんでした。設定でカメラを許可するか、「写真から」を使ってください", 5000);
    return;
  }
  const v = $("video"); v.srcObject = SC.stream;
  try { await v.play(); } catch (e) {}
  try { const [track] = SC.stream.getVideoTracks(); const caps = track.getCapabilities?.(); if (caps?.focusMode?.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) {}
  if ("BarcodeDetector" in window) {
    try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes("ean_13")) SC.detector = new BarcodeDetector({ formats: ["ean_13"] }); } catch (e) {}
  }
  tick();
}
function closeScanner() {
  clearTimeout(SC.timer); SC.timer = 0;
  if (SC.stream) SC.stream.getTracks().forEach((t) => t.stop());
  SC.stream = null; $("video").srcObject = null; $("scanner").hidden = true;
  render();
}
async function tick() {
  if ($("scanner").hidden) return;
  if (!SC.paused) {
    const v = $("video");
    if (v.readyState >= 2 && v.videoWidth) {
      let codes = [];
      if (SC.detector) {
        try { codes = (await SC.detector.detect(v)).map((x) => x.rawValue); } catch (e) {}
      } else {
        // 枠のあたり（中央の横長部分）だけを切り出して解析
        const vw = v.videoWidth, vh = v.videoHeight, sh = vh * 0.42, sy = (vh - sh) / 2;
        const sc = Math.min(1, 1100 / vw), c = SC.canvas;
        c.width = Math.round(vw * sc); c.height = Math.round(sh * sc);
        c.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, sy, vw, sh, 0, 0, c.width, c.height);
        const t = zxDecodeCanvas(c); if (t) codes = [t];
      }
      const isbn = codes.find(isbn13ok);
      if (isbn && !(isbn === SC.last && Date.now() - SC.lastAt < 4000)) { SC.last = isbn; SC.lastAt = Date.now(); onScanned(isbn); }
      else if (!isbn && codes.some((c) => /^19[12]/.test(c))) $("scanHint").textContent = "それは値段のバーコードです。上側の 978… を写してください";
    }
  }
  SC.timer = setTimeout(tick, SC.detector ? 120 : 80);
}
function updateScanCount() { $("scanCount").textContent = SC.added ? `${SC.added}冊追加` : ""; }
function scanCard(html) { const c = $("scanCard"); c.innerHTML = html; c.hidden = false; }
function resumeScan() { $("scanCard").hidden = true; SC.paused = false; SC.lastAt = Date.now(); }
function bookBlock(b) {
  return `<div class="sc-book">${b.cover ? `<img src="${esc(b.cover)}" alt="" referrerpolicy="no-referrer">` : ""}<div><div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || "")}${b.publisher ? " · " + esc(b.publisher) : ""}</div><div class="a">ISBN ${esc(b.isbn)}</div></div></div>`;
}
async function onScanned(isbn) {
  SC.paused = true;
  try { navigator.vibrate?.(60); } catch (e) {}
  const dupId = DB.findByIsbn(isbn);
  if (dupId) {
    const b = DB.books.get(dupId);
    scanCard(`<p class="sc-msg">この本はすでに本棚にあります（${esc(b.status)}）。状況を変えるならタップ。</p>${bookBlock(b)}
      <div class="sc-status">${STATUSES.map((s) => `<button class="s-${s}" data-st="${s}" ${b.status === s ? 'aria-pressed="true"' : ""}>${s}</button>`).join("")}</div>
      <div class="actions"><button class="btn primary" id="scNext">次の本を読む</button></div>`);
    $("scanCard").querySelector(".sc-status").onclick = (e) => {
      const st = e.target.closest("button")?.dataset.st; if (!st) return;
      DB.put(dupId, { ...b, status: st, updatedAt: Date.now() }); toast(`「${b.title}」を${st}にしました`); resumeScan();
    };
    $("scNext").onclick = resumeScan;
    return;
  }
  scanCard(`<p class="sc-msg">ISBN ${esc(isbn)} を読み取りました。本の情報を調べています…</p>`);
  const info = await lookup(isbn);
  if ($("scanner").hidden) return;
  if (!info) {
    const pub = guessPublisher(isbn);
    scanCard(`<p class="sc-msg warn">ISBN ${esc(isbn)} の情報が見つかりませんでした。タイトルを手入力してください。</p>
      <div class="actions"><button class="btn" id="scSkip">スキップ</button><button class="btn primary" id="scManual">手入力で追加</button></div>`);
    $("scSkip").onclick = resumeScan;
    $("scManual").onclick = () => { closeScanner(); openNew({ isbn, publisher: pub }); };
    return;
  }
  const book = { ...info, isbn };
  scanCard(`${bookBlock(book)}<p class="hint" style="margin:10px 0 0">読書状況を選ぶとすぐ追加します</p>
    <div class="sc-status">${STATUSES.map((s) => `<button class="s-${s}" data-st="${s}">${s}で追加</button>`).join("")}</div>
    <div class="actions"><button class="btn" id="scSkip">スキップ</button><button class="btn" id="scEdit" style="flex:1">編集してから追加</button></div>`);
  $("scanCard").querySelector(".sc-status").onclick = (e) => {
    const st = e.target.closest("button")?.dataset.st; if (!st) return;
    addBook(book, st); SC.added++; updateScanCount(); toast(`「${book.title}」を追加しました`); resumeScan();
  };
  $("scSkip").onclick = resumeScan;
  $("scEdit").onclick = () => { closeScanner(); openNew(book, { text: `${info.source} の情報です。確認して追加してください。` }); };
}
$("scanBtn").onclick = openScanner;
$("scanClose").onclick = closeScanner;
$("scanPhoto").onclick = () => { $("photoInput").value = ""; $("photoInput").click(); };
$("manualBtn").onclick = () => openNew();

/* ---------- barcode: photo fallback ---------- */
async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) {}
  return await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
function canvasFrom(img, maxW, region, rot) {
  const W = img.width, H = img.height;
  const sy = region === "bottom" ? H * 0.4 : 0, sh = region === "full" ? H : H * 0.6;
  const sc = Math.min(1, maxW / Math.max(W, sh)), w = Math.round(W * sc), h = Math.round(sh * sc);
  const c = document.createElement("canvas");
  if (rot) { c.width = h; c.height = w; } else { c.width = w; c.height = h; }
  const x = c.getContext("2d", { willReadFrequently: true });
  if (rot) { x.translate(h, 0); x.rotate(Math.PI / 2); }
  x.drawImage(img, 0, sy, W, sh, 0, 0, w, h);
  return c;
}
async function decodeFile(file) {
  const img = await loadBitmap(file); const found = [];
  if ("BarcodeDetector" in window) {
    try { const d = new BarcodeDetector({ formats: ["ean_13"] }); (await d.detect(img)).forEach((x) => found.push(x.rawValue)); } catch (e) {}
    const hit = found.find(isbn13ok); if (hit) return { isbn: hit };
  }
  for (const maxW of [1400, 900, 2000]) for (const rot of [false, true]) for (const region of ["full", "top", "bottom"]) {
    const t = zxDecodeCanvas(canvasFrom(img, maxW, region, rot));
    if (t) { found.push(t); if (isbn13ok(t)) return { isbn: t }; }
  }
  return { other: found };
}
$("photoInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  busy(true, "バーコードを読み取り中…");
  let r; try { r = await decodeFile(f); } catch (err) { r = { other: [] }; }
  busy(false);
  if (r.isbn) {
    if ($("scanner").hidden) { $("scanner").hidden = false; SC.added = 0; updateScanCount(); }
    onScanned(r.isbn);
  } else if (r.other.some((v) => /^19[12]/.test(v))) toast("値段のバーコード（192…）を読みました。上側の 978… を大きく撮ってください", 5000);
  else toast("バーコードを読み取れませんでした。ピントを合わせて撮り直してください", 5000);
});

/* ---------- import / export ---------- */
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
function toTime(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(+v);
  const t = Date.parse(String(v).replace(/\//g, "-")); return isNaN(t) ? 0 : t;
}
function importRecords(records) {
  let added = 0, updated = 0;
  for (const rec of records) {
    const title = String(rec.title || "").trim(); if (!title) continue;
    const isbn = toIsbn13(rec.isbn) || "";
    let id = rec.id && /^[A-Za-z0-9_-]+$/.test(rec.id) ? rec.id : null;
    const byIsbn = isbn ? DB.findByIsbn(isbn) : null;
    if (byIsbn) id = byIsbn;
    if (!id) id = DB.nextId();
    const prev = DB.books.get(id);
    const b = { ...(prev || {}) };
    for (const k of ["title", "author", "publisher", "label", "series", "volume", "releaseDate", "location", "genres", "memo", "cover", "format"]) if (rec[k] != null) b[k] = String(rec[k]);
    b.isbn = isbn || b.isbn || "";
    b.status = STATUSES.includes(rec.status) ? rec.status : b.status || "未読";
    b.addedAt = toTime(rec.addedAt) || b.addedAt || Date.now();
    b.updatedAt = toTime(rec.updatedAt) || b.addedAt;
    b.format = b.format || "紙";
    DB.books.set(id, b); prev ? updated++ : added++;
  }
  DB.save();
  return { added, updated };
}
$("importInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const text = (await f.text()).replace(/^﻿/, "");
    let records;
    if (/^\s*[\[{]/.test(text)) {
      const j = JSON.parse(text);
      records = Array.isArray(j) ? j : Array.isArray(j.books) ? j.books : Object.entries(j.books || {}).map(([id, b]) => ({ id, ...b }));
    } else {
      const [head, ...rows] = parseCsv(text);
      records = rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
    }
    const r = importRecords(records);
    closeSheet(); render();
    toast(`取り込みました：新規 ${r.added} 冊・更新 ${r.updated} 冊`, 4500);
  } catch (err) { console.error(err); toast("このファイルは読み込めませんでした（JSONかCSVを選んでください）", 5000); }
});
async function shareOrDownload(filename, text, type) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], filename, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return true; }
  } catch (e) { if (e.name === "AbortError") return false; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
async function exportJson() {
  const books = [...DB.books.entries()].map(([id, b]) => ({ id, ...b }));
  const ok = await shareOrDownload(`本棚バックアップ_${today()}.json`, JSON.stringify({ app: "hondana", version: 1, exportedAt: new Date().toISOString(), books }, null, 1), "application/json");
  if (ok) { DB.meta.lastBackup = Date.now(); DB.save(); toast("バックアップを書き出しました"); closeSheet(); }
}
async function exportCsv() {
  const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const lines = [CSV_COLS.join(",")].concat([...DB.books.entries()].map(([id, b]) => CSV_COLS.map((c) => (c === "id" ? q(id) : c === "addedAt" ? q(b.addedAt ? new Date(b.addedAt).toISOString().slice(0, 10) : "") : q(b[c]))).join(",")));
  if (await shareOrDownload(`本棚_${today()}.csv`, "﻿" + lines.join("\n"), "text/csv")) { toast("CSVを書き出しました"); closeSheet(); }
}
async function fetchCovers() {
  const targets = [...DB.books.entries()].filter(([, b]) => b.isbn && !b.cover);
  if (!targets.length) { toast("表紙が未取得の本はありません"); return; }
  closeSheet(); let got = 0;
  for (let i = 0; i < targets.length; i += 100) {
    busy(true, `表紙を取得中… ${Math.min(i + 100, targets.length)} / ${targets.length}`);
    const chunk = targets.slice(i, i + 100);
    try {
      const j = await fetchJson(`https://api.openbd.jp/v1/get?isbn=${chunk.map(([, b]) => b.isbn).join(",")}`, 20000);
      j.forEach((item, k) => {
        const s = item && item.summary; if (!s) return;
        const [id, b] = chunk[k]; let ch = false;
        if (s.cover) { b.cover = s.cover; got++; ch = true; }
        if (!b.releaseDate && s.pubdate) { b.releaseDate = fmtDate(s.pubdate); ch = true; }
        if (ch) DB.books.set(id, b);
      });
    } catch (e) { busy(false); toast("通信できませんでした。電波のよい場所でもう一度試してください"); DB.save(); render(); return; }
  }
  DB.save(); busy(false); render();
  toast(`${got} 冊の表紙を取得しました${targets.length - got ? `（${targets.length - got} 冊は見つかりませんでした）` : ""}`, 4500);
}
function fmtAgo(t) { if (!t) return "まだありません"; const d = Math.floor((Date.now() - t) / 86400000); return d === 0 ? "今日" : `${d}日前`; }
$("menuBtn").onclick = () => {
  const all = [...DB.books.values()], d = all.filter((b) => b.status === "読了").length, noCover = all.filter((b) => b.isbn && !b.cover).length;
  const old = !DB.meta.lastBackup || Date.now() - DB.meta.lastBackup > 30 * 86400000;
  openSheet(`<h2>メニュー</h2><p class="sub">全 ${all.length} 冊 · 読了 ${d} 冊（${all.length ? Math.round((d / all.length) * 100) : 0}%）</p>
  ${old && all.length ? `<p class="notice warn">データはこの端末の中だけに保存されています。機種変更や削除に備えて、ときどきバックアップを書き出してください（最終バックアップ：${fmtAgo(DB.meta.lastBackup)}）。</p>` : ""}
  <div class="menu">
    <h3>バックアップ</h3>
    <button class="btn" id="mJson">バックアップを書き出す（JSON）</button>
    <button class="btn" id="mCsv">CSVで書き出す（スプシ用）</button>
    <button class="btn" id="mImport">ファイルから取り込む（JSON / CSV）</button>
    <h3>本の情報</h3>
    <button class="btn" id="mCovers">表紙画像をまとめて取得${noCover ? `（${noCover} 冊）` : ""}</button>
    <p class="hint">最終バックアップ：${fmtAgo(DB.meta.lastBackup)}</p>
    <button class="btn" id="mClose">閉じる</button>
  </div>`);
  $("mJson").onclick = exportJson; $("mCsv").onclick = exportCsv;
  $("mImport").onclick = () => $("importInput").click();
  $("mCovers").onclick = fetchCovers; $("mClose").onclick = closeSheet;
};

/* ---------- boot ---------- */
DB.load();
render();
try { navigator.storage?.persist?.(); } catch (e) {}
if (DB.books.size && (!DB.meta.lastBackup || Date.now() - DB.meta.lastBackup > 30 * 86400000) && Date.now() - (DB.meta.lastNudge || 0) > 7 * 86400000) {
  DB.meta.lastNudge = Date.now(); DB.save();
  setTimeout(() => toast("しばらくバックアップしていません。右上の「…」から書き出せます", 5000), 1200);
}
window.addEventListener("storage", (e) => { if (e.key === STORE_KEY) { DB.load(); render(); } });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
