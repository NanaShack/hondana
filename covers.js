"use strict";
/* 表紙画像の取得（本棚・新刊チェック共通）
 * 順番に試して、見つかったものを端末に覚えておく：
 *   保存済みの表紙 → Google Books → Amazon → 国立国会図書館 → 背表紙風の代わりの絵
 * 「画像なし」の扱い：1x1 などの極小画像、Google の正方形の「○月の新刊」バナーは表紙とみなさない
 */
const Covers = (() => {
  const KEY = "hondana.covers";
  let ok = {};
  try { ok = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
  let saveT;
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(ok)); } catch (e) {} }, 500); };
  const remember = (isbn, url) => { if (!isbn || ok[isbn] === url) return; ok[isbn] = url; persist(); };
  const forget = (isbn) => { if (isbn && ok[isbn]) { delete ok[isbn]; persist(); } };
  function isbn10(i) {
    if (!/^978\d{10}$/.test(i)) return "";
    const b = i.slice(3, 12); let s = 0;
    for (let k = 0; k < 9; k++) s += (10 - k) * +b[k];
    const d = (11 - (s % 11)) % 11;
    return b + (d === 10 ? "X" : String(d));
  }
  function sources(isbn, saved) {
    const list = [];
    if (isbn && ok[isbn]) list.push(ok[isbn]);
    if (saved && !/cover\.openbd\.jp/.test(saved)) list.push(saved);
    if (isbn) {
      list.push(`https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1`);
      const i10 = isbn10(isbn);
      if (i10) list.push(`https://images-na.ssl-images-amazon.com/images/P/${i10}.09.MZZZZZZZ.jpg`);
      list.push(`https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`);
    }
    return [...new Set(list)];
  }
  const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  /** isbn・保存済みURL・クラス名・見つからないときのHTML から <img> を作る */
  function img(isbn, saved, cls, fallbackHtml) {
    const list = sources(isbn, saved);
    if (!list.length) return fallbackHtml;
    return `<img class="${attr(cls)} cv" src="${attr(list[0])}" data-rest="${attr(list.slice(1).join("\n"))}" data-isbn="${attr(isbn || "")}" data-ph="${attr(fallbackHtml)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  function next(el) {
    const rest = (el.dataset.rest || "").split("\n").filter(Boolean);
    if (el.dataset.isbn && ok[el.dataset.isbn] === el.currentSrc) forget(el.dataset.isbn);
    if (rest.length) { el.dataset.rest = rest.slice(1).join("\n"); el.src = rest[0]; return; }
    const t = document.createElement("template"); t.innerHTML = el.dataset.ph || ""; el.replaceWith(t.content);
  }
  document.addEventListener("error", (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && el.classList.contains("cv")) next(el);
  }, true);
  document.addEventListener("load", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement) || !el.classList.contains("cv")) return;
    const w = el.naturalWidth, h = el.naturalHeight;
    const banner = /books\.google/.test(el.currentSrc) && Math.abs(w - h) < 4;   // 正方形の新刊バナー
    if (w < 10 || h < 10 || banner) { next(el); return; }
    remember(el.dataset.isbn, el.currentSrc);
  }, true);
  return { img, sources };
})();
