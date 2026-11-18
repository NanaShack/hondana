"use strict";
/* 新刊チェック — 本棚の作家の新刊・発売予定を国立国会図書館サーチで調べる */

const LIB_KEY = "hondana.v1";
const SK_KEY = "hondana.shinkan";
const STALE_MS = 3 * 86400000;     // 作家ごとの結果は3日間使い回す
const LOOKBACK_MONTHS = 4;          // 何か月前の発売まで表示するか
const API = "https://ndlsearch.ndl.go.jp/api/opensearch";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　／/・,，、.。:：;；!！?？'"“”‘’「」『』【】\[\]()（）〈〉《》<>＜＞≪≫~〜\-ー―‐]/g, "");
const nameKey = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　／/]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- storage ---------- */
function loadLib() { try { const r = JSON.parse(localStorage.getItem(LIB_KEY) || "null"); return r ? r : { books: {}, meta: {} }; } catch (e) { return { books: {}, meta: {} }; } }
let LIB = loadLib();
const SK = Object.assign({ follow: {}, extra: [], cache: {}, hidden: [], covers: {} }, (() => { try { return JSON.parse(localStorage.getItem(SK_KEY) || "{}"); } catch (e) { return {}; } })());
function saveSK() { try { localStorage.setItem(SK_KEY, JSON.stringify(SK)); } catch (e) { toast("端末の保存容量がいっぱいです"); } }

let toastT;
function toast(msg, ms = 3200) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

/* ---------- 本棚から作家・シリーズ・持っている本を集める ---------- */
function libraryIndex() {
  const books = Object.values(LIB.books || {});
  const authors = new Map();   // nameKey -> {name, count}
  const owned = { isbn: new Set(), title: new Set() };
  const series = new Map();    // norm key -> 表示名
  for (const b of books) {
    const first = String(b.author || "").split(/[、,／/]/)[0].trim();
    const k = nameKey(first);
    if (k && !/編集部|編集委員会/.test(k)) {
      const a = authors.get(k) || { name: k, count: 0 }; a.count++; authors.set(k, a);
    }
    if (b.isbn) owned.isbn.add(b.isbn);
    owned.title.add(norm(b.title));
    // 巻数のついた本・シリーズ名のある本だけを「シリーズ」とみなす
    const t = String(b.title).normalize("NFKC");
    const volMatch = /^(.+?)\s*(?:[（(〈<\[【]\s*(?:第)?\d+\s*(?:巻)?\s*[)）〉>\]】]|\s\d+\s*$|\d+\s*$)/.exec(t);
    const sname = b.series || (volMatch ? volMatch[1] : "");
    const sk = norm(sname);
    if (sk.length >= 2) series.set(sk, sname.trim());
  }
  return { authors, owned, series };
}
let IDX = libraryIndex();
function followed() {
  const list = [];
  for (const a of IDX.authors.values()) {
    const f = SK.follow[a.name];
    if (f === true || (f !== false && a.count >= 2)) list.push(a.name);
  }
  for (const n of SK.extra) if (!list.includes(n) && SK.follow[n] !== false) list.push(n);
  return list;
}

/* ---------- 日付 ---------- */
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;
const THIS_MONTH = TODAY.slice(0, 7);
function monthsAgo(n) { const d = new Date(NOW.getFullYear(), NOW.getMonth() - n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
const FROM = monthsAgo(LOOKBACK_MONTHS);
function parseDate(...cands) {
  for (const c of cands) {
    const s = String(c || "").normalize("NFKC");
    let m = /(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /(\d{4})[-./年](\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  }
  return "";
}
function fmtDate(d) {
  if (!d) return "";
  const [y, m, dd] = d.split("-");
  const yy = y === TODAY.slice(0, 4) ? "" : `${y}年`;
  return dd ? `${yy}${+m}月${+dd}日` : `${yy}${+m}月`;
}
function phase(d) {
  if (d.length === 10) return d > TODAY ? "soon" : d.slice(0, 7) === THIS_MONTH ? "month" : "past";
  return d > THIS_MONTH ? "soon" : d === THIS_MONTH ? "month" : "past";
}

/* ---------- 国立国会図書館サーチ ---------- */
const textOf = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ""; };
const textsOf = (el, tag) => [...el.getElementsByTagName(tag)].map((n) => n.textContent.trim()).filter(Boolean);
function parseItems(xmlText, author) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const out = [];
  for (const it of doc.getElementsByTagName("item")) {
    const cats = textsOf(it, "category");
    if (cats.some((c) => /デジタル|電子/.test(c))) continue;
    let title = textOf(it, "dc:title") || textOf(it, "title");
    if (!title || /話売り|分冊版|単話/.test(title)) continue;
    const vol = textOf(it, "dcndl:volume");
    if (vol && !norm(title).includes(norm(vol))) title += " " + vol;
    const creators = textsOf(it, "dc:creator").map((c) => c.replace(/／/g, "").replace(/,\s*\d{4}-?\d*$/, "").replace(/^([^,]+),\s*([^,]+)$/, "$1$2").trim());
    const who = norm(creators.join(" ") + " " + textOf(it, "author"));
    if (!who.includes(norm(author))) continue;           // 同姓同名や部分一致の取り違えを除く
    const date = parseDate(textOf(it, "dc:date"), textOf(it, "dcterms:issued"));
    if (!date || date < FROM) continue;
    let isbn = "";
    for (const idn of it.getElementsByTagName("dc:identifier")) {
      const t = idn.getAttribute("xsi:type") || "";
      if (/ISBN/.test(t)) { const d = idn.textContent.replace(/[^0-9X]/gi, ""); if (d.length === 13) { isbn = d; break; } }
    }
    if (!isbn) for (const sa of it.getElementsByTagName("rdfs:seeAlso")) { const m = /97[89]\d{10}/.exec(sa.getAttribute("rdf:resource") || ""); if (m) { isbn = m[0]; break; } }
    out.push({
      title, isbn, date, author: [...new Set(creators)].slice(0, 4).join("、") || author,
      publisher: textOf(it, "dc:publisher"), label: textOf(it, "dcndl:seriesTitle"),
      price: textOf(it, "dcndl:price"), link: textOf(it, "link"), via: author,
      ndc: [...it.getElementsByTagName("dc:subject")].find((el) => /NDC/.test(el.getAttribute("xsi:type") || ""))?.textContent.trim() || "",
    });
  }
  return out;
}
async function queryAuthor(author, signal) {
  const url = `${API}?creator=${encodeURIComponent(author)}&cnt=80&mediatype=books&from=${FROM}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
    const onStop = () => ac.abort(); signal.addEventListener("abort", onStop);
    try {
      const r = await fetch(url, { signal: ac.signal });
      const text = await r.text();
      if (r.status === 429 || /<code>429<\/code>/.test(text)) { await sleep(5000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return parseItems(text, author);
    } catch (e) {
      if (signal.aborted) throw e;
      if (attempt === 3) throw e;
      await sleep(3000);
    } finally { clearTimeout(t); signal.removeEventListener("abort", onStop); }
  }
  throw new Error("busy");
}

/* ---------- 更新 ---------- */
let RUN = null;
async function run(force) {
  if (RUN) return;
  const names = followed();
  const todo = names.filter((n) => force || !SK.cache[n] || Date.now() - SK.cache[n].at > STALE_MS);
  if (!todo.length) { if (force) toast("すべて確認済みです"); return; }
  RUN = new AbortController();
  $("progress").hidden = false; $("refreshBtn").disabled = true;
  let done = 0, failed = 0;
  for (const name of todo) {
    if (RUN.signal.aborted) break;
    $("ptext").textContent = `${name} さんの新刊を確認中…（${done + 1} / ${todo.length}）`;
    $("pbar").style.width = `${(done / todo.length) * 100}%`;
    try { SK.cache[name] = { at: Date.now(), items: await queryAuthor(name, RUN.signal) }; saveSK(); render(); }
    catch (e) { if (RUN.signal.aborted) break; failed++; }
    done++;
    await sleep(800); // 図書館のサーバーに負担をかけないよう少し間をあける
  }
  const stopped = RUN.signal.aborted;
  RUN = null; $("progress").hidden = true; $("refreshBtn").disabled = false;
  render();
  if (stopped) toast(`途中で止めました（${done} / ${todo.length} 人確認済み）`);
  else if (failed) toast(`${failed} 人分は混雑のため確認できませんでした。時間をおいて「今すぐ更新」してください`, 5000);
}
$("stopBtn").onclick = () => RUN && RUN.abort();
$("refreshBtn").onclick = () => run(true);

/* ---------- 表示 ---------- */
let FILTER = "all", KIND = "all";
function kindOf(it) { const g = Kinds.guess(it); return g.sure ? g.kind : Kinds.fromNdc(it.ndc, g.kind) || "その他"; }
function collect() {
  const names = followed(), hidden = new Set(SK.hidden), seen = new Map();
  for (const n of names) for (const it of (SK.cache[n]?.items || [])) {
    const key = it.isbn || norm(it.title) + "|" + norm(it.publisher);
    if (hidden.has(key) || it.date < FROM) continue;
    if ((it.isbn && IDX.owned.isbn.has(it.isbn)) || IDX.owned.title.has(norm(it.title))) continue;
    const prev = seen.get(key);
    if (prev) { if (!prev.isbn && it.isbn) prev.isbn = it.isbn; if (prev.date.length < it.date.length) prev.date = it.date; continue; }
    const nt = norm(it.title); let sk = "";
    for (const k of IDX.series.keys()) if (nt.startsWith(k) && k.length > sk.length) sk = k;
    const own = /^(.+?)\s*(?:[（(〈<\[【]\s*(?:第)?\d+\s*(?:巻)?\s*[)）〉>\]】]|\s\d+(?:巻)?(?=\s|$)|\d+\s*$)/.exec(String(it.title).normalize("NFKC"));
    const gname = sk ? IDX.series.get(sk) : own ? own[1].trim() : "";
    seen.set(key, { ...it, key, series: sk ? IDX.series.get(sk) : "", gkey: gname ? norm(gname) : key, gname, phase: phase(it.date) });
  }
  return [...seen.values()];
}
/* 表紙：openBD → 国立国会図書館のサムネイル → 頭文字 */
const coverOf = (isbn) => (isbn && SK.covers[isbn]?.u) || "";
function coverSrc(isbn) { return coverOf(isbn) || (isbn ? `https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg` : ""); }
function thumb(it) {
  const ch = esc(String(it.title).trim().charAt(0));
  return `<span class="thumb">${Covers.img(it.isbn, coverOf(it.isbn), "", ch)}</span>`;
}
let coverBusy = false;
async function ensureCovers() {
  if (coverBusy) return;
  const need = [...new Set(ITEMS.map((i) => i.isbn).filter((x) => x && (!SK.covers[x] || (!SK.covers[x].u && Date.now() - SK.covers[x].at > 7 * 86400000))))];
  if (!need.length) return;
  coverBusy = true; let got = false;
  try {
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const r = await fetch(`https://api.openbd.jp/v1/get?isbn=${chunk.join(",")}`);
      const j = await r.json();
      chunk.forEach((isbn, k) => { const u = j[k]?.summary?.cover || ""; SK.covers[isbn] = { u, at: Date.now() }; if (u) got = true; });
    }
    saveSK();
  } catch (e) {} finally { coverBusy = false; }
  if (got) render();
}
function itemHtml(it) {
  const badges = [it.series ? `<span class="badge">${esc(it.series)} の続き</span>` : "", it.phase === "soon" ? `<span class="badge soon">発売予定</span>` : ""].join("");
  return `<button class="nb" data-key="${esc(it.key)}">${thumb(it)}<span class="main"><div class="t">${esc(it.title)}</div><div class="a">${it.kind ? `<span class="ktag">${esc(it.kind)}</span>` : ""}${esc(it.author)}${it.publisher ? " · " + esc(it.publisher) : ""}</div>${badges ? `<div class="badges">${badges}</div>` : ""}</span><span class="date"><b>${esc(fmtDate(it.date))}</b>${it.phase === "soon" ? "発売予定" : "発売"}</span></button>`;
}
let ITEMS = [];
function render() {
  IDX = libraryIndex();
  const names = followed();
  $("followCount").textContent = names.length;
  const checked = names.filter((n) => SK.cache[n]);
  const last = Math.max(0, ...checked.map((n) => SK.cache[n].at));
  $("updated").textContent = last ? `最終確認 ${new Date(last).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}（${checked.length} / ${names.length} 人）` : "まだ確認していません";
  ITEMS = collect();
  const counts = { all: ITEMS.length, series: ITEMS.filter((i) => i.series).length, soon: ITEMS.filter((i) => i.phase === "soon").length };
  $("chips").innerHTML = [["all", "すべて"], ["series", "シリーズの続き"], ["soon", "発売予定"]].map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${FILTER === k}">${l} ${counts[k]}</button>`).join("");
  ITEMS.forEach((i) => (i.kind = kindOf(i)));
  const kc = {}; ITEMS.forEach((i) => (kc[i.kind] = (kc[i.kind] || 0) + 1));
  if (KIND !== "all" && !kc[KIND]) KIND = "all";
  $("kinds").innerHTML = [["all", "ジャンル：すべて"], ...Kinds.LIST.filter((k) => kc[k]).map((k) => [k, `${k} ${kc[k]}`])].map(([k, l]) => `<button class="chip kchip" data-k="${k}" aria-pressed="${KIND === k}">${l}</button>`).join("");
  const list = ITEMS.filter((i) => (FILTER === "all" || (FILTER === "series" ? i.series : i.phase === "soon")) && (KIND === "all" || i.kind === KIND));
  const empty = $("empty");
  if (!Object.keys(LIB.books || {}).length) {
    $("sections").innerHTML = ""; empty.hidden = false;
    empty.innerHTML = `<h2>本棚に本がありません</h2><p>本を登録すると、その作家の新刊をここで確認できます。</p><a class="headlink" href="./">本棚へ</a>`; return;
  }
  if (!names.length) {
    $("sections").innerHTML = ""; empty.hidden = false;
    empty.innerHTML = `<h2>フォロー中の作家がいません</h2><p>右上の「作家」から新刊を知りたい作家を選んでください。</p>`; return;
  }
  if (!list.length) {
    $("sections").innerHTML = ""; empty.hidden = false;
    empty.innerHTML = checked.length ? `<h2>新刊は見つかりませんでした</h2><p>${FILTER === "all" ? `直近${LOOKBACK_MONTHS}か月と発売予定に、まだ持っていない本はありません。` : "絞り込みを「すべて」に戻してみてください。"}</p>` : `<h2>新刊を確認しています</h2><p>作家ごとに順番に調べるので、初回は数分かかります。<br>このページを開いたままお待ちください。</p>`;
    return;
  }
  empty.hidden = true;
  // 同じシリーズの巻は1行にまとめ、タップで開く
  const grouped = (arr) => {
    const m = new Map(); for (const it of arr) { if (!m.has(it.gkey)) m.set(it.gkey, []); m.get(it.gkey).push(it); }
    return [...m.values()].map((g) => {
      if (g.length === 1) return itemHtml(g[0]);
      const f = g[0], badges = [f.series ? `<span class="badge">${esc(f.series)} の続き</span>` : "", g.some((i) => i.phase === "soon") ? `<span class="badge soon">発売予定</span>` : ""].join("");
      const dates = g.map((i) => i.date).sort();
      return `<details class="sgrp"><summary class="nb">${thumb(f)}<span class="main"><div class="t">${esc(f.gname)} <span class="cnt">${g.length}冊</span></div><div class="a">${esc(f.author)}${f.publisher ? " · " + esc(f.publisher) : ""}</div>${badges ? `<div class="badges">${badges}</div>` : ""}</span><span class="date"><b>${esc(fmtDate(dates[0]))}</b>${dates.length > 1 && dates[0] !== dates[dates.length - 1] ? "〜" + esc(fmtDate(dates[dates.length - 1])) : ""}</span></summary><div class="sgrp-in">${g.map(itemHtml).join("")}</div></details>`;
    }).join("");
  };
  const sec = (title, note, arr) => arr.length ? `<section class="sec"><h2>${title}<small>${note}</small></h2>${grouped(arr)}</section>` : "";
  const asc = (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "ja", { numeric: true });
  $("sections").innerHTML =
    sec("発売予定", `${list.filter((i) => i.phase === "soon").length}冊`, list.filter((i) => i.phase === "soon").sort(asc)) +
    sec("今月発売", `${list.filter((i) => i.phase === "month").length}冊`, list.filter((i) => i.phase === "month").sort(asc)) +
    sec("最近発売", `${LOOKBACK_MONTHS}か月以内`, list.filter((i) => i.phase === "past").sort((a, b) => -asc(a, b)));
}
$("chips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; FILTER = c.dataset.f; render(); });
$("kinds").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; KIND = c.dataset.k; render(); });

/* ---------- シート ---------- */
function openSheet(html) { const s = $("sheet"); s.innerHTML = `<div class="grip"></div>` + html; s.hidden = false; $("veil").hidden = false; s.scrollTop = 0; }
function closeSheet() { $("sheet").hidden = true; $("veil").hidden = true; }
$("veil").addEventListener("click", () => { const wasAuthors = $("sheet").dataset.kind === "authors"; closeSheet(); if (wasAuthors) { render(); run(false); } });

$("sections").addEventListener("click", (e) => {
  const b = e.target.closest(".nb"); if (!b) return;
  const it = ITEMS.find((i) => i.key === b.dataset.key); if (!it) return;
  $("sheet").dataset.kind = "item";
  const q = encodeURIComponent(it.isbn || it.title);
  openSheet(`<div class="head">${it.isbn ? Covers.img(it.isbn, coverOf(it.isbn), "hcover", "") : ""}<div class="main"><h2>${esc(it.title)}</h2><p class="sub">${esc(it.author)}</p></div></div>
    <p class="sub">${esc(it.publisher)}${it.label ? `（${esc(it.label)}）` : ""} · ${esc(fmtDate(it.date))}${it.phase === "soon" ? "発売予定" : "発売"}${it.price ? ` · ${Number(it.price).toLocaleString()}円` : ""}${it.isbn ? `<br>ISBN ${esc(it.isbn)}` : ""}</p>
    ${it.series ? `<p class="notice">本棚の「${esc(it.series)}」の続きのようです。</p>` : ""}
    <div class="linkrow">
      ${it.link ? `<a class="btn" href="${esc(it.link)}" target="_blank" rel="noopener">国立国会図書館サーチで詳しく見る</a>` : ""}
      ${it.isbn ? `<a class="btn" href="https://www.books.or.jp/book-details/${esc(it.isbn)}" target="_blank" rel="noopener">Books（出版書誌データベース）で見る</a>` : ""}
      <a class="btn" href="https://www.amazon.co.jp/s?k=${q}&i=stripbooks" target="_blank" rel="noopener">Amazonで探す</a>
      <a class="btn" href="https://books.rakuten.co.jp/search?sitem=${q}" target="_blank" rel="noopener">楽天ブックスで探す</a>
    </div>
    <div class="actions"><button class="btn" id="hideBtn">興味なし</button><button class="btn primary" id="boughtBtn">買った（本棚に追加）</button></div>
    <div class="actions" style="margin-top:8px"><button class="btn" id="closeBtn" style="flex:1">閉じる</button></div>`);
  $("closeBtn").onclick = closeSheet;
  $("hideBtn").onclick = () => { SK.hidden.push(it.key); saveSK(); closeSheet(); render(); toast("この本を表示しないようにしました"); };
  $("boughtBtn").onclick = () => {
    LIB = loadLib(); LIB.books = LIB.books || {};
    let m = 0; for (const id of Object.keys(LIB.books)) { const n = /^BOOK-(\d+)$/.exec(id); if (n) m = Math.max(m, +n[1]); }
    const now = Date.now();
    LIB.books["BOOK-" + String(m + 1).padStart(4, "0")] = {
      title: it.title, author: it.author, publisher: it.publisher, label: it.label || "", series: it.series || "", volume: "",
      isbn: it.isbn || "", releaseDate: it.date.replace(/-/g, "/"), location: "", genres: "", memo: "",
      cover: coverOf(it.isbn), status: "未読", format: "紙", addedAt: now, updatedAt: now,
    };
    try { localStorage.setItem(LIB_KEY, JSON.stringify(LIB)); } catch (e) { toast("保存できませんでした"); return; }
    closeSheet(); render(); toast(`「${it.title}」を本棚に追加しました`);
  };
});

/* 作家の選択 */
function authorsSheet() {
  $("sheet").dataset.kind = "authors";
  const names = new Set(followed());
  const all = [...IDX.authors.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
  const extra = SK.extra.filter((n) => !IDX.authors.has(n));
  openSheet(`<h2>新刊を知りたい作家</h2><p class="sub">チェックした作家の新刊を調べます。最初は本棚に2冊以上ある作家を選んでいます。</p>
    <div class="addrow"><input id="addName" placeholder="本棚にない作家を追加（例：宮部みゆき）" autocomplete="off"><button class="btn" id="addBtn">追加</button></div>
    <div class="alist" id="alist">
      ${extra.map((n) => `<label><input type="checkbox" data-n="${esc(n)}" ${names.has(n) ? "checked" : ""}><span>${esc(n)} <em>追加した作家</em></span><button class="linkbtn" data-del="${esc(n)}">削除</button></label>`).join("")}
      ${all.map((a) => `<label><input type="checkbox" data-n="${esc(a.name)}" ${names.has(a.name) ? "checked" : ""}><span>${esc(a.name)}</span><small>${a.count}冊</small></label>`).join("")}
    </div>
    <div class="actions"><button class="btn primary" id="doneBtn">完了</button></div>`);
  $("alist").addEventListener("change", (e) => {
    const n = e.target.dataset.n; if (!n) return;
    const a = IDX.authors.get(n);
    if (e.target.checked) SK.follow[n] = a && a.count >= 2 ? undefined : true;
    else SK.follow[n] = false;
    if (SK.follow[n] === undefined) delete SK.follow[n];
    saveSK(); $("followCount").textContent = followed().length;
  });
  $("alist").addEventListener("click", (e) => {
    const d = e.target.closest("[data-del]"); if (!d) return; e.preventDefault();
    const n = d.dataset.del; SK.extra = SK.extra.filter((x) => x !== n); delete SK.follow[n]; delete SK.cache[n]; saveSK(); authorsSheet();
  });
  const add = () => {
    const n = nameKey($("addName").value); if (!n) return;
    if (!IDX.authors.has(n) && !SK.extra.includes(n)) SK.extra.unshift(n);
    SK.follow[n] = true; saveSK(); authorsSheet();
  };
  $("addBtn").onclick = add;
  $("addName").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  $("doneBtn").onclick = () => { closeSheet(); render(); run(false); };
}
$("authorsBtn").onclick = authorsSheet;

/* ---------- 起動 ---------- */
render();
run(false);
window.addEventListener("storage", (e) => { if (e.key === LIB_KEY) { LIB = loadLib(); render(); } });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
