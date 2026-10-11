/**
 * r84 — BRAIN-P1: nền toán MLP (blueprint §4.1 — 2026-10-12)
 * ============================================================================
 * Thuần, DB-cô-lập (không import db — đúng pattern gate). 5 nhóm theo
 * spec blueprint:
 *   1. Đạo hàm backward khớp SAI PHÂN HỮU HẠN (numerical gradient check,
 *      20 spec ngẫu nhiên tất định — phủ đủ menu activation trơn + cặp
 *      gộp sigmoid+bce / softmax+CE).
 *   2. MLP học được bài toán logistic KHÔNG giải được: XOR 2-2-1
 *      (tầng ẩn có giá trị thật) — kèm đối chứng 0 tầng ẩn thất bại.
 *   3. Tất định: cùng seed + cùng dữ liệu → cùng weights bit-đối-bit.
 *   4. Adam hội tụ nhanh hơn SGD (cùng bài, cùng ngưỡng loss).
 *   5. Serialize → deserialize → predict GIỐNG HỆT (+ envelope A6).
 * Cộng nhóm 6: validation spec (audit B1 + cặp loss/activation) và
 * ổn định số (audit B3).
 */

import { describe, test, expect } from 'bun:test'
import {
  ACTIVATIONS,
  ACTIVATION_NAMES,
  softmaxVector,
  type ActivationName,
} from '@/lib/brain/activations'
import { LOSSES, LOSS_NAMES, BCE_EPSILON, sampleLoss } from '@/lib/brain/losses'
import { makeRng, randn } from '@/lib/brain/init'
import { createOptimizer, SGD_MOMENTUM, ADAM_BETA1, ADAM_BETA2 } from '@/lib/brain/optimizers'
import { MLP, type MlpSpec } from '@/lib/brain/mlp'

// ==================== DỮ LIỆU XOR KINH ĐIỂN ====================

const XOR_X: readonly (readonly number[])[] = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
]
const XOR_Y: readonly (readonly number[])[] = [[0], [1], [1], [0]]

function xorAccuracy(mlp: MLP): number {
  let ok = 0
  for (let i = 0; i < XOR_X.length; i++) {
    const p = mlp.predictProba(XOR_X[i])
    if ((p > 0.5 ? 1 : 0) === XOR_Y[i][0]) ok++
  }
  return ok / 4
}

// ==================== 1. NUMERICAL GRADIENT CHECK ====================

// Pool activation TRƠN cho sai phân hữu hạn (ReLU/Leaky ReLU có kink tại 0
// — đạo hàm của chúng được kiểm riêng bằng đơn vị ở nhóm 6).
const SMOOTH_ACTS: ActivationName[] = ['sigmoid', 'tanh', 'elu', 'swish', 'gelu']
const FD_EPSILON = 1e-5

function buildRandomSpec(i: number): { spec: MlpSpec; x: number[]; y: number[] } {
  const rng = makeRng(1000 + i)
  const inDim = 2 + Math.floor(rng() * 2) // 2–3
  const hiddenCount = 1 + Math.floor(rng() * 2) // 1–2
  const layers: MlpSpec['layers'] = [{ units: inDim, activation: 'linear' }]
  for (let h = 0; h < hiddenCount; h++) {
    layers.push({
      units: 2 + Math.floor(rng() * 2),
      activation: SMOOTH_ACTS[Math.floor(rng() * SMOOTH_ACTS.length)],
    })
  }
  const lossPool = ['bce', 'mse', 'huber', 'crossEntropy'] as const
  const loss = lossPool[i % lossPool.length]
  if (loss === 'bce') {
    layers.push({ units: 1 + Math.floor(rng() * 2), activation: 'sigmoid' })
  } else if (loss === 'crossEntropy') {
    layers.push({ units: 2 + Math.floor(rng() * 2), activation: 'softmax' })
  } else {
    layers.push({ units: 1 + Math.floor(rng() * 2), activation: 'linear' })
  }
  const spec: MlpSpec = {
    layers,
    loss,
    optimizer: 'adam',
    lr: 0.01,
    l2: 0, // gradient-check trên loss dữ liệu thuần (L2 chỉ cộng trong fit)
    seed: i,
  }
  const x = Array.from({ length: inDim }, () => rng() * 1.6 - 0.8)
  let y: number[]
  if (loss === 'bce') {
    y = Array.from({ length: layers[layers.length - 1].units }, () => (rng() < 0.5 ? 0 : 1))
  } else if (loss === 'crossEntropy') {
    const k = Math.floor(rng() * layers[layers.length - 1].units)
    y = Array.from({ length: layers[layers.length - 1].units }, (_, j) => (j === k ? 1 : 0))
  } else {
    y = Array.from({ length: layers[layers.length - 1].units }, () => rng() * 2 - 1)
  }
  return { spec, x, y }
}

describe('r84 · BRAIN-P1 (1) gradient-check sai phân hữu hạn — 20 spec', () => {
  for (let i = 0; i < 20; i++) {
    test(`spec #${i}`, () => {
      const { spec, x, y } = buildRandomSpec(i)
      const mlp = new MLP(spec)
      const { dW, db } = mlp.backward(x, y)
      const weights = mlp.inspectWeights()

      // Duyệt MỌI tham số (mạng nhỏ: vài chục) — nhiễu loạn ±ε rồi so
      const checkTensor = (
        analytic: Float64Array,
        live: Float64Array,
        kind: 'W' | 'b',
        l: number,
      ) => {
        for (let k = 0; k < analytic.length; k++) {
          const original = live[k]
          live[k] = original + FD_EPSILON
          const lp = mlp.lossOf(x, y)
          live[k] = original - FD_EPSILON
          const lm = mlp.lossOf(x, y)
          live[k] = original // phục hồi
          const numeric = (lp - lm) / (2 * FD_EPSILON)
          const diff = Math.abs(analytic[k] - numeric)
          const tol = 1e-4 + 1e-3 * Math.abs(numeric)
          // throw thủ công (thay vì expect(msg) — bun-types chỉ nhận 1 tham
          // số) để giữ đủ ngữ cảnh chẩn đoán khi fail
          if (diff > tol) {
            throw new Error(
              `${kind}[lớp ${l}][${k}]: analytic ${analytic[k]} vs sai phân ${numeric} — lệch ${diff} > dung sai ${tol}`,
            )
          }
        }
      }
      for (let l = 0; l < dW.length; l++) {
        checkTensor(dW[l], weights.W[l] as Float64Array, 'W', l + 1)
        checkTensor(db[l], weights.b[l] as Float64Array, 'b', l + 1)
      }
    })
  }
})

// ==================== 2. XOR — TẦNG ẨN CÓ GIÁ TRỊ THẬT ====================

describe('r84 · BRAIN-P1 (2) XOR — MLP đa lớp thắng, logistic 0 tầng ẩn thua', () => {
  test('logistic 1 lớp (0 tầng ẩn) KHÔNG giải được XOR', () => {
    const logistic = new MLP({
      layers: [
        { units: 2, activation: 'linear' },
        { units: 1, activation: 'sigmoid' },
      ],
      loss: 'bce',
      optimizer: 'adam',
      lr: 0.1,
      l2: 0,
      seed: 7,
    })
    const res = logistic.fit(XOR_X, XOR_Y, { epochs: 2000, holdOutRatio: 0, batchSize: 4 })
    // XOR không tách tuyến tính — trần của logistic là 3/4 đúng
    expect(xorAccuracy(logistic)).toBeLessThan(1)
    expect(res.finalTrainLoss).toBeGreaterThan(0.3)
  })

  test('MLP 2-2-1 (tanh ẩn) học XOR trọn 4/4', () => {
    const mlp = new MLP({
      layers: [
        { units: 2, activation: 'linear' },
        { units: 2, activation: 'tanh' },
        { units: 1, activation: 'sigmoid' },
      ],
      loss: 'bce',
      optimizer: 'adam',
      lr: 0.05,
      l2: 0,
      seed: 20261012,
    })
    const res = mlp.fit(XOR_X, XOR_Y, { epochs: 3000, holdOutRatio: 0, batchSize: 4 })
    expect(xorAccuracy(mlp)).toBe(1)
    // Biên độ tin cậy: đúng là chưa đủ — phải ĐẬM (loss < 0.1)
    expect(res.finalTrainLoss).toBeLessThan(0.1)
    for (let i = 0; i < 4; i++) {
      const p = mlp.predictProba(XOR_X[i])
      if (XOR_Y[i][0] === 1) expect(p).toBeGreaterThan(0.9)
      else expect(p).toBeLessThan(0.1)
    }
  })
})

// ==================== 3. TẤT ĐỊNH BIT-ĐỐI-BIT ====================

describe('r84 · BRAIN-P1 (3) cùng seed + dữ liệu → cùng weights bit-đối-bit', () => {
  const buildSpec = (): MlpSpec => ({
    layers: [
      { units: 4, activation: 'linear' },
      { units: 3, activation: 'tanh' },
      { units: 1, activation: 'sigmoid' },
    ],
    loss: 'bce',
    optimizer: 'adam',
    lr: 0.05,
    l2: 0.001,
    seed: 20261012,
  })

  const buildData = () => {
    const rng = makeRng(999)
    const X: number[][] = []
    const y: number[][] = []
    for (let i = 0; i < 12; i++) {
      X.push(Array.from({ length: 4 }, () => rng() * 2 - 1))
      y.push([rng() < 0.5 ? 0 : 1])
    }
    return { X, y }
  }

  test('2 instance độc lập → serialize JSON trùng khớp tuyệt đối', () => {
    const { X, y } = buildData()
    const a = new MLP(buildSpec())
    const b = new MLP(buildSpec())
    const ra = a.fit(X, y, { epochs: 60, holdOutRatio: 0.15, batchSize: 4 })
    const rb = b.fit(X, y, { epochs: 60, holdOutRatio: 0.15, batchSize: 4 })
    const sa = JSON.stringify(a.serialize())
    const sb = JSON.stringify(b.serialize())
    expect(sa).toBe(sb)
    expect(ra.epochsRun).toBe(rb.epochsRun)
    expect(ra.history.length).toBe(rb.history.length)
    expect(ra.finalTrainLoss).toBe(rb.finalTrainLoss)
  })

  test('predict trên đầu vào thăm dò cũng trùng bit', () => {
    const { X, y } = buildData()
    const a = new MLP(buildSpec())
    const b = new MLP(buildSpec())
    a.fit(X, y, { epochs: 30, holdOutRatio: 0 })
    b.fit(X, y, { epochs: 30, holdOutRatio: 0 })
    const probe = [0.3, -0.7, 0.11, 0.9]
    const pa = a.predict(probe)
    const pb = b.predict(probe)
    expect(pa.length).toBe(pb.length)
    for (let i = 0; i < pa.length; i++) expect(pa[i]).toBe(pb[i])
  })
})

// ==================== 4. ADAM NHANH HƠN SGD ====================

describe('r84 · BRAIN-P1 (4) Adam hội tụ nhanh hơn SGD (cùng bài, cùng ngưỡng)', () => {
  test('hồi quy sin(x): epoch tới ngưỡng của Adam < SGD', () => {
    // Dữ liệu tất định
    const rng = makeRng(4242)
    const X: number[][] = []
    const y: number[][] = []
    for (let i = 0; i < 20; i++) {
      const x = rng() * 2 - 1
      X.push([x])
      y.push([Math.sin(x * Math.PI)]) // phi tuyến — cần tầng ẩn
    }
    const THRESHOLD = 0.01
    const CAP = 3000

    const epochsToThreshold = (opt: 'adam' | 'sgd'): number => {
      const mlp = new MLP({
        layers: [
          { units: 1, activation: 'linear' },
          { units: 8, activation: 'tanh' },
          { units: 1, activation: 'linear' },
        ],
        loss: 'mse',
        optimizer: opt,
        lr: 0.05,
        l2: 0,
        seed: 20261012,
      })
      const res = mlp.fit(X, y, { epochs: CAP, holdOutRatio: 0, batchSize: 8 })
      const hit = res.history.find(h => h.trainLoss < THRESHOLD)
      return hit ? hit.epoch : CAP + 1 // không chạm ngưỡng = thua
    }

    const adamEpochs = epochsToThreshold('adam')
    const sgdEpochs = epochsToThreshold('sgd')
    expect(adamEpochs).toBeLessThanOrEqual(CAP) // Adam phải tới được
    expect(adamEpochs).toBeLessThan(sgdEpochs) // và nhanh hơn
  })
})

// ==================== 5. SERIALIZE ↔ DESERIALIZE (audit A6) ====================

describe('r84 · BRAIN-P1 (5) serialize/deserialize — envelope numpy-đọc-được', () => {
  test('roundtrip JSON → predict GIỐNG HỆT (===)', () => {
    const mlp = new MLP({
      layers: [
        { units: 5, activation: 'linear' },
        { units: 4, activation: 'gelu' },
        { units: 2, activation: 'softmax' },
      ],
      loss: 'crossEntropy',
      optimizer: 'adam',
      lr: 0.01,
      l2: 0,
      seed: 99,
    })
    const dataRng = makeRng(99)
    const X = Array.from({ length: 8 }, () => Array.from({ length: 5 }, () => randn(dataRng)))
    const y = X.map(() => [0, 1])
    mlp.fit(X, y, { epochs: 20, holdOutRatio: 0 })

    const json = JSON.parse(JSON.stringify(mlp.serialize())) // qua chuỗi — như weightsJson
    const restored = MLP.deserialize(json)
    for (let i = 0; i < X.length; i++) {
      const pa = mlp.predict(X[i])
      const pb = restored.predict(X[i])
      for (let j = 0; j < pa.length; j++) expect(pb[j]).toBe(pa[j])
    }
  })

  test('envelope đúng chuẩn A6: dtype float64 + shape [out,in]/[out] + đủ tensor', () => {
    const mlp = new MLP({
      layers: [
        { units: 3, activation: 'linear' },
        { units: 2, activation: 'tanh' },
        { units: 1, activation: 'sigmoid' },
      ],
      loss: 'bce',
      optimizer: 'sgd',
      lr: 0.01,
      l2: 0,
      seed: 1,
    })
    const s = mlp.serialize()
    expect(s.tensors).toHaveLength(4) // 2 lớp trọng số × (W + b)
    const [w1, b1, w2, b2] = s.tensors
    expect(w1.kind).toBe('W')
    expect(w1.layer).toBe(1)
    expect(w1.envelope.dtype).toBe('float64')
    expect(w1.envelope.shape).toEqual([2, 3])
    expect(w1.envelope.data).toHaveLength(6)
    expect(b1.envelope.shape).toEqual([2])
    expect(w2.envelope.shape).toEqual([1, 2])
    expect(b2.envelope.shape).toEqual([1])
    expect(mlp.paramCount()).toBe(6 + 2 + 2 + 1) // 11
  })

  test('deserialize chặn dữ liệu hỏng (dtype sai / thiếu phần tử)', () => {
    const mlp = new MLP({
      layers: [
        { units: 2, activation: 'linear' },
        { units: 1, activation: 'sigmoid' },
      ],
      loss: 'bce',
      optimizer: 'adam',
      lr: 0.01,
      l2: 0,
      seed: 3,
    })
    const s = mlp.serialize()
    const bad1 = JSON.parse(JSON.stringify(s))
    bad1.tensors[0].envelope.dtype = 'float32'
    expect(() => MLP.deserialize(bad1)).toThrow(/dtype/)
    const bad2 = JSON.parse(JSON.stringify(s))
    bad2.tensors[0].envelope.data = bad2.tensors[0].envelope.data.slice(0, 1)
    expect(() => MLP.deserialize(bad2)).toThrow(/phần tử/)
  })
})

// ==================== 6. VALIDATION + ỔN ĐỊNH SỐ (audit B1/B3) ====================

describe('r84 · BRAIN-P1 (6a) validateSpec — cặp loss/activation + audit B1', () => {
  const base = {
    optimizer: 'adam' as const,
    lr: 0.01,
    l2: 0,
    seed: 1,
  }

  test('softmax ở lớp ẩn BỊ CẤM (audit B1)', () => {
    expect(
      () =>
        new MLP({
          ...base,
          layers: [
            { units: 2, activation: 'linear' },
            { units: 3, activation: 'softmax' },
            { units: 1, activation: 'sigmoid' },
          ],
          loss: 'bce',
        }),
    ).toThrow(/B1|softmax/)
  })

  test('bce yêu cầu output sigmoid; mse/huber cấm sigmoid/softmax output', () => {
    expect(
      () =>
        new MLP({
          ...base,
          layers: [
            { units: 2, activation: 'linear' },
            { units: 1, activation: 'linear' },
          ],
          loss: 'bce',
        }),
    ).toThrow(/sigmoid/)
    expect(
      () =>
        new MLP({
          ...base,
          layers: [
            { units: 2, activation: 'linear' },
            { units: 1, activation: 'sigmoid' },
          ],
          loss: 'mse',
        }),
    ).toThrow(/tuyến tính/)
  })

  test('crossEntropy yêu cầu softmax ≥ 2 unit (audit B1)', () => {
    expect(
      () =>
        new MLP({
          ...base,
          layers: [
            { units: 2, activation: 'linear' },
            { units: 1, activation: 'softmax' },
          ],
          loss: 'crossEntropy',
        }),
    ).toThrow(/crossEntropy|softmax/)
  })

  test('cần ≥ 2 lớp; units ≥ 1; activation phải có trong menu', () => {
    expect(() => new MLP({ ...base, layers: [{ units: 2, activation: 'linear' }], loss: 'mse' })).toThrow(/2 lớp/)
    expect(
      () =>
        new MLP({
          ...base,
          layers: [
            { units: 0, activation: 'linear' },
            { units: 1, activation: 'linear' },
          ],
          loss: 'mse',
        }),
    ).toThrow(/units/)
  })

  test('menu đủ 9 activation + 4 loss (mở rộng §9.2)', () => {
    expect(ACTIVATION_NAMES).toHaveLength(9)
    expect(ACTIVATION_NAMES).toContain('leakyRelu')
    expect(ACTIVATION_NAMES).toContain('elu')
    expect(ACTIVATION_NAMES).toContain('swish')
    expect(ACTIVATION_NAMES).toContain('gelu')
    expect(LOSS_NAMES).toHaveLength(4)
  })
})

describe('r84 · BRAIN-P1 (6b) đạo hàm activation đơn vị (kink-safe — kiểm analytic)', () => {
  test('relu / leakyRelu: đạo hàm hai nhánh đúng', () => {
    expect(ACTIVATIONS.relu.backward(2)).toBe(1)
    expect(ACTIVATIONS.relu.backward(-2)).toBe(0)
    expect(ACTIVATIONS.leakyRelu.backward(2)).toBe(1)
    expect(ACTIVATIONS.leakyRelu.backward(-2)).toBe(0.01)
    expect(ACTIVATIONS.leakyRelu.backward(-2, { alpha: 0.2 })).toBe(0.2)
    expect(ACTIVATIONS.leakyRelu.forward(-2, { alpha: 0.2 })).toBeCloseTo(-0.4, 12)
  })

  test('elu: φ′(z) = α·e^z ở nhánh âm; swish: φ′(0) = 0.5; gelu(0) = 0', () => {
    expect(ACTIVATIONS.elu.backward(-1, { alpha: 1 })).toBeCloseTo(Math.exp(-1), 12)
    expect(ACTIVATIONS.elu.forward(-1, { alpha: 1 })).toBeCloseTo(Math.exp(-1) - 1, 12)
    expect(ACTIVATIONS.swish.backward(0)).toBeCloseTo(0.5, 12)
    expect(ACTIVATIONS.gelu.forward(0)).toBe(0)
    expect(Number.isFinite(ACTIVATIONS.gelu.backward(3))).toBe(true)
  })

  test('sigmoid ổn định hai đầu (audit B3): không NaN/∞ ở ±1000', () => {
    expect(ACTIVATIONS.sigmoid.forward(1000)).toBeCloseTo(1, 12)
    expect(ACTIVATIONS.sigmoid.forward(-1000)).toBeCloseTo(0, 12)
    expect(Number.isFinite(ACTIVATIONS.sigmoid.backward(-1000))).toBe(true)
  })

  test('softmaxVector: tổng = 1, ổn định z lớn (log-sum-exp)', () => {
    const p = softmaxVector([1000, 1001, 1002])
    expect(p.every(v => Number.isFinite(v))).toBe(true)
    expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12)
    expect(p[2]).toBeGreaterThan(p[0])
  })
})

describe('r84 · BRAIN-P1 (6c) ổn định loss (audit B3) + hằng số optimizer', () => {
  test('BCE kẹp ε hai đầu: biên 0/1 cho số hữu hạn', () => {
    expect(Number.isFinite(LOSSES.bce.fn(0, 0))).toBe(true)
    expect(Number.isFinite(LOSSES.bce.fn(1, 1))).toBe(true)
    expect(Number.isFinite(LOSSES.bce.deriv(0, 1))).toBe(true)
    // Kẹp đúng biên ε
    expect(LOSSES.bce.fn(0, 1)).toBe(-Math.log(BCE_EPSILON))
  })

  test('huber mượt qua kink; sampleLoss scale đúng quy ước mean/sum', () => {
    expect(LOSSES.huber.fn(0.5, 0, { delta: 1 })).toBeCloseTo(0.125, 12)
    expect(LOSSES.huber.deriv(3, 0, { delta: 1 })).toBe(1)
    // mean theo unit cho bce/mse/huber…
    expect(sampleLoss('mse', [1, 3], [0, 0])).toBeCloseTo((1 + 9) / 2, 12)
    // …sum theo unit cho crossEntropy (chỉ đầu ra đích góp phần — one-hot)
    expect(sampleLoss('crossEntropy', [0.5, 0.5], [1, 0])).toBeCloseTo(-Math.log(0.5), 12)
  })

  test('hằng số optimizer đúng blueprint §4.1', () => {
    expect(SGD_MOMENTUM).toBe(0.9)
    expect(ADAM_BETA1).toBe(0.9)
    expect(ADAM_BETA2).toBe(0.999)
    expect(() => createOptimizer('adam', 0)).toThrow(/lr/)
    expect(() => createOptimizer('sgd', -1)).toThrow(/lr/)
  })

  test('early stopping: patience chặn + trả weights epoch tốt nhất (audit B2)', () => {
    // Dữ liệu nhiễu thuần (không tín hiệu) — hold-out không cải thiện lâu
    // → phải dừng sớm thay vì chạy hết 800 epoch.
    const rng = makeRng(777)
    const X: number[][] = []
    const y: number[][] = []
    for (let i = 0; i < 24; i++) {
      X.push([rng() * 2 - 1])
      y.push([rng() * 2 - 1]) // nhiễu thuần
    }
    const mlp = new MLP({
      layers: [
        { units: 1, activation: 'linear' },
        { units: 16, activation: 'tanh' },
        { units: 1, activation: 'linear' },
      ],
      loss: 'mse',
      optimizer: 'adam',
      lr: 0.01,
      l2: 0,
      seed: 20261012,
    })
    const res = mlp.fit(X, y, { epochs: 800, patience: 20, holdOutRatio: 0.25, batchSize: 8 })
    expect(res.stoppedEarly).toBe(true)
    expect(res.epochsRun).toBeLessThan(800)
    expect(res.bestEpoch).toBeLessThanOrEqual(res.epochsRun)
    expect(res.bestLoss).toBeLessThanOrEqual(res.finalValLoss ?? res.finalTrainLoss)
  })
})
