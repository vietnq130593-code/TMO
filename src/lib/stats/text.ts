/**
 * Đo lường văn bản (text overlap metrics) — module thuần toán, không side-effect.
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (ML.pdf §NLP Evaluation —
 * ROUGE-L, token-set F1). Nhà tiêu thụ chính: P3-M4 ROUGE-L digest gate.
 *
 * Convention: token hoá bằng split whitespace (giữ nguyên chữ hoa/thường),
 * chuỗi rỗng/toàn khoảng trắng → mảng token rỗng. Các giá trị degenerate
 * (mẫu số 0) → 0, trừ trường hợp cả hai TẬP token cùng rỗng của tokenSetF1
 * (hai chuỗi rỗng xem như khớp hoàn toàn → 1).
 */

/** Token hoá: split whitespace, bỏ chuỗi rỗng. */
function tokenize(s: string): string[] {
  const t = s.trim();
  return t === "" ? [] : t.split(/\s+/);
}

/**
 * Độ dài dãy con chung dài nhất (LCS) trên hai mảng token — DP hai hàng
 * (bộ nhớ O(min-column), không phụ thuộc nội dung).
 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

/**
 * ROUGE-L mức token:
 *   precision = LCS/len(hyp token), recall = LCS/len(ref token),
 *   f1 = 2PR/(P+R).
 * Chuỗi rỗng → các giá trị degenerate = 0.
 *
 * Lưu ý erratum BUG2-036: ví dụ blueprint ghi rougeL("the cat sat", "the cat")
 * có "recall 1.0" — thực chất đó là PRECISION (LCS = 2 token, hyp = 2 token,
 * ref = 3 token → precision 1.0, recall 2/3).
 */
export function rougeL(reference: string, hypothesis: string): {
  precision: number;
  recall: number;
  f1: number;
} {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  const lcs = lcsLength(ref, hyp);
  const precision = hyp.length === 0 ? 0 : lcs / hyp.length;
  const recall = ref.length === 0 ? 0 : lcs / ref.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Token-set F1: F1 = 2·|A∩B|/(|A|+|B|) trên TẬP token (mỗi loại đếm 1 lần —
 * khác ROUGE-L vốn theo thứ tự/số lần). Cả hai rỗng → 1 (khớp hoàn toàn);
 * một bên rỗng → 0.
 */
export function tokenSetF1(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}
