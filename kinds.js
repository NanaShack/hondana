"use strict";
/* 本のジャンル（漫画・小説・ライトノベル・新書・参考書・雑誌・その他）の自動判定。本棚・新刊チェック共通。
 * 1) レーベル名・出版社・タイトルから判定（確実なものは sure: true）
 * 2) 分からないものは国立国会図書館の分類番号（NDC）で判定
 */
const Kinds = (() => {
  const LIST = ["漫画", "小説", "ライトノベル", "新書", "参考書", "雑誌", "その他"];
  const N = (s) => String(s || "").normalize("NFKC");
  const RE = {
    magazine: /magazine|マガジン\s*vol|\bvol\.\s*\d+|ムック|ファンブック|公式ガイド|増刊/i,
    study: /検定|試験|合格|問題集|過去問|参考書|教科書|ドリル|単語帳?|資格|exampress|施工管理|TOEIC|英検|漢検|入試|受験|ワークブック/i,
    manga: /コミック|comics?\b|\bKC\b|KCデラックス|ジャンプ・?コミックス|劇画|漫画|まんが|マンガ/i,
    ln: /電撃文庫|スニーカー文庫|MF文庫|ファンタジア文庫|GA文庫|ガガガ文庫|HJ文庫|ファミ通文庫|オーバーラップ文庫|ダッシュエックス文庫|ラノベ文庫|ビーンズ文庫|電撃の新文芸|カドカワBOOKS|MFブックス|ヒーロー文庫|アース・スター|モンスター文庫|Kラノベ|GCノベルズ|ドラゴンノベルス|一迅社文庫|講談社ラノベ|L文庫|ルビー文庫/i,
    lnPublisher: /^(TOブックス|ホビージャパン|オーバーラップ|フロンティアワークス|アルファポリス|マイクロマガジン社)$/,
    shinsho: /新書/,
    novelLabel: /文庫|ノベルス|ノベルズ|jBOOKS|タイガ|ENTERTAINMENT|洋書|ミステリ|ポケミス/i,
  };
  /** 本の情報から推定する。{ kind, sure } を返す（sure=false は図書館の分類で確かめたいもの） */
  function guess(b) {
    const label = N(b.label), title = N(b.title), pub = N(b.publisher), tags = N(b.genres);
    if (RE.magazine.test(title) || /ムック/.test(label)) return { kind: "雑誌", sure: true };
    if (RE.study.test(title) || RE.study.test(label) || /資格|学習|参考/.test(tags)) return { kind: "参考書", sure: true };
    if (RE.manga.test(label) || RE.manga.test(pub)) return { kind: "漫画", sure: true };
    if (RE.ln.test(label) || RE.lnPublisher.test(pub)) return { kind: "ライトノベル", sure: true };
    if (RE.shinsho.test(label) && !/ノベルス/.test(label)) return { kind: "新書", sure: true };
    if (RE.novelLabel.test(label)) return { kind: "小説", sure: false };   // 文庫にはエッセイや実用書もある
    return { kind: "", sure: false };
  }
  /** 国立国会図書館の分類番号（NDC）からジャンルを決める */
  function fromNdc(ndc, fallback) {
    const s = String(ndc || "").replace(/[^0-9.]/g, "");
    if (!s) return fallback || "";
    if (/^726/.test(s)) return "漫画";
    if (/^9\d3/.test(s)) return fallback === "ライトノベル" ? "ライトノベル" : "小説";
    if (/^37[56]/.test(s) || /^8[3-9]7/.test(s)) return "参考書";
    if (/^0[5]/.test(s)) return "雑誌";
    return "その他";
  }
  return { LIST, guess, fromNdc };
})();
