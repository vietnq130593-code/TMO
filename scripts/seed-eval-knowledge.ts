/**
 * R39 — Seed eval case KNOWLEDGE-DOMAIN khớp corpus 9 shard D0 (USER DUYỆT
 * 2026-10-18 "Duyệt từ 1 đến 3" — mục 2). Bối cảnh: EvalCase cũ toàn
 * programming/algorithm/ml + negative security → mismatch domain với corpus
 * D0 (toán/evolution/NAS/psy) → eval run 100% refusal (R38 phát hiện, alert
 * eval-starvation thế hệ 2). Bộ case mới được HAND-CRAFTED bám sát nội dung
 * THẬT của 9 shard knowledge/ (ENTITY_NAME/DESCRIPTION_SHORT đọc trực tiếp
 * từ file .TXT) — câu trả lời nằm TRONG corpus nên đo được đường KB thật.
 *
 * 27 case = 3/shard × 9 shard, category='knowledge' (filter riêng cho eval
 * run), source='d0_corpus', difficulty easy/medium/hard trộn.
 *
 * Idempotent: bỏ qua khi question đã tồn tại (tiền lệ seed-eval.ts).
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bun scripts/seed-eval-knowledge.ts
 */

import { db } from '../src/lib/db'

interface SeedCase {
  question: string
  expectedAnswer: string
  expectedEntities: Array<{ name: string; type: string }>
  difficulty: 'easy' | 'medium' | 'hard'
  shard: string
}

/** 27 case — mỗi shard 3 case, entity name KHỚP tên ENTITY_NAME trong corpus
 *  (để judge match entity) — expectedAnswer tổng thuật nội dung DESCRIPTION_SHORT. */
const CASES: SeedCase[] = [
  // ===== SHD_GEN_CAUSAL_HYPER_001 — Causal AI / thông tin =====
  {
    shard: 'SHD_GEN_CAUSAL_HYPER_001',
    question: 'What is a Structural Causal Model and how does it represent cause-effect relationships?',
    expectedAnswer:
      'A Structural Causal Model (SCM) represents causal relationships using directed acyclic graphs (DAGs) where nodes are variables and directed edges encode causal influences. Unlike purely statistical correlation, an SCM supports interventions and counterfactual reasoning, allowing one to predict effects of manipulating variables rather than just observing them.',
    expectedEntities: [
      { name: 'Structural Causal Model', type: 'Concept' },
      { name: 'Directed Acyclic Graphs', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_GEN_CAUSAL_HYPER_001',
    question: 'What does the Vapnik-Chervonenkis (VC) dimension measure?',
    expectedAnswer:
      'The VC dimension measures the capacity or complexity of a hypothesis class: the largest number of points that the class can shatter (label in all possible ways). It underpins generalization bounds in statistical learning theory — higher VC dimension means greater expressive power but greater risk of overfitting.',
    expectedEntities: [{ name: 'Vapnik-Chervonenkis (VC) Dimension', type: 'Concept' }],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_GEN_CAUSAL_HYPER_001',
    question: 'Explain channel capacity and its role in reliable communication.',
    expectedAnswer:
      'Channel capacity (C) is the maximum rate at which information can be transmitted through a noisy channel with arbitrarily low error probability (Shannon). Coding schemes such as turbo codes with trellis graph structure and jointly-typical set decoding approach this limit in practice, trading computation and block length for reliability.',
    expectedEntities: [
      { name: 'Channel Capacity', type: 'Concept' },
      { name: 'Turbo Codes', type: 'Technology' },
    ],
    difficulty: 'hard',
  },
  // ===== SHD_NAS_EVOLUTION_002 — AutoML =====
  {
    shard: 'SHD_NAS_EVOLUTION_002',
    question: 'What is DARTS and how does it make neural architecture search differentiable?',
    expectedAnswer:
      'DARTS (Differentiable Architecture Search) relaxes the discrete architecture search space into a continuous one by placing a softmax mixture over candidate operations, then optimizes architecture weights jointly with network weights via gradient descent. The final discrete architecture is derived by keeping the operations with the largest mixture weights — avoiding the cost of training every candidate architecture separately.',
    expectedEntities: [{ name: 'DARTS (Differentiable Architecture Search)', type: 'Technology' }],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_NAS_EVOLUTION_002',
    question: 'Explain the supernet concept in NAS and the ranking correlation problem.',
    expectedAnswer:
      'A supernet is an over-parameterized network containing all candidate sub-architectures with shared weights, so candidates can be evaluated by inheriting supernet weights instead of training from scratch. The ranking correlation problem is that the performance ranking of sub-networks inside the supernet often does not correlate with their performance when trained independently — measured by ranking-correlation metrics between supernet evaluation and retraining.',
    expectedEntities: [{ name: 'Supernet', type: 'Concept' }],
    difficulty: 'hard',
  },
  {
    shard: 'SHD_NAS_EVOLUTION_002',
    question: 'What are the search space and the search strategy in a neural architecture search pipeline?',
    expectedAnswer:
      'Neural Architecture Search (NAS) automates the design of neural network architectures. The search space defines the set of candidate architectures (operations, connections, topology constraints), while the search strategy coordinates how the space is explored — e.g. reinforcement learning, evolutionary methods, or gradient-based methods like DARTS — to find architectures with optimal performance.',
    expectedEntities: [
      { name: 'Search Space', type: 'Concept' },
      { name: 'Search Strategy', type: 'Concept' },
    ],
    difficulty: 'easy',
  },
  // ===== SHD_OPT_CONVEX_003 — Tối ưu lồi =====
  {
    shard: 'SHD_OPT_CONVEX_003',
    question: 'What are shadow prices (Lagrange multipliers) in constrained optimization?',
    expectedAnswer:
      'Shadow prices (Lagrange multipliers) are the dual variables of a constrained optimization problem: they measure the sensitivity of the optimal objective value to a small relaxation of the corresponding constraint. A nonzero shadow price signals an active (binding) constraint, while a zero value indicates slack — the constraint does not limit the optimum.',
    expectedEntities: [{ name: 'Shadow Prices', type: 'Concept' }],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_OPT_CONVEX_003',
    question: 'Define the objective function, decision variables and feasible region of an optimization problem.',
    expectedAnswer:
      'Decision variables are the unknowns we are free to choose; the objective function maps those variables to the value being minimized or maximized; the feasible region is the subset of the decision space satisfying all constraints. In convex optimization the objective and feasible region are convex, so any local optimum is global.',
    expectedEntities: [
      { name: 'Objective Function', type: 'Concept' },
      { name: 'Decision Variables', type: 'Concept' },
      { name: 'Feasible Region', type: 'Concept' },
    ],
    difficulty: 'easy',
  },
  {
    shard: 'SHD_OPT_CONVEX_003',
    question: 'What is convex duality and what role do slack variables play in it?',
    expectedAnswer:
      'Convex duality associates a primal problem with a dual problem over Lagrange multipliers; for convex problems under constraint qualification strong duality holds and the duality gap is zero, so the dual certifies the primal optimum. Slack variables convert inequality constraints into equalities plus nonnegative variables measuring violation; complementary slackness links zero slack with multiplier values, connecting primal and dual solutions.',
    expectedEntities: [{ name: 'Slack Variables', type: 'Concept' }],
    difficulty: 'hard',
  },
  // ===== SHD_SYS_DYNAMICS_004 — Điều khiển/Active inference =====
  {
    shard: 'SHD_SYS_DYNAMICS_004',
    question: 'What is the Markov blanket in the context of active inference?',
    expectedAnswer:
      'The Markov blanket is the set of nodes (sensory and active states) separating internal states from external states: internal states influence the external world only through the blanket. In active inference, an agent minimizes surprise about its sensory states under a generative model, and the blanket defines the boundary of the "self" that can be inferred and controlled.',
    expectedEntities: [
      { name: 'Markov Blanket', type: 'Concept' },
      { name: 'Active Inference', type: 'Principle' },
    ],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_SYS_DYNAMICS_004',
    question: 'Explain variational free energy (VFE) and expected free energy (EFE).',
    expectedAnswer:
      'Variational free energy (VFE) is an upper bound on surprise (negative log-evidence) of observations given a generative model; minimizing VFE implements approximate Bayesian inference. Expected free energy (EFE) extends this to future observations under candidate policies and decomposes into epistemic value (expected information gain) and pragmatic value (preferred states), which drives action selection in active inference.',
    expectedEntities: [
      { name: 'Variational Free Energy (VFE)', type: 'Concept' },
      { name: 'Expected Free Energy (EFE)', type: 'Concept' },
    ],
    difficulty: 'hard',
  },
  {
    shard: 'SHD_SYS_DYNAMICS_004',
    question: 'What role does a Lyapunov function play in stability analysis of autonomous systems?',
    expectedAnswer:
      'A Lyapunov function V is a scalar function of the system state that is positive definite around an equilibrium and non-increasing along trajectories. If its time derivative is negative, the equilibrium is (asymptotically) stable — this certifies stability without solving the differential equations explicitly, and relates to convergence toward a non-equilibrium steady state in dissipative systems.',
    expectedEntities: [{ name: 'Lyapunov Function', type: 'Concept' }],
    difficulty: 'medium',
  },
  // ===== SHD_CORE_GRAPH_005 — Đồ thị =====
  {
    shard: 'SHD_CORE_GRAPH_005',
    question: 'Explain the stock and flow formalism in system dynamics modeling.',
    expectedAnswer:
      'Stocks are accumulations (state variables) that change over time; flows are rates that fill or drain the stocks; auxiliary variables and delay elements shape how flows depend on stocks and exogenous signals. Feedback loops coupling stocks and flows — positive amplifying or negative stabilizing — generate the dynamic behavior of the modeled system.',
    expectedEntities: [
      { name: 'Stock', type: 'Concept' },
      { name: 'Flow', type: 'Concept' },
    ],
    difficulty: 'easy',
  },
  {
    shard: 'SHD_CORE_GRAPH_005',
    question: 'What is a C-component in causal graph theory?',
    expectedAnswer:
      'A C-component is a maximal set of vertices connected to each other by bidirected edges, meaning they share latent (unobserved) confounders. C-components are the key structure in modern identifiability theory: causal effects are identified by decomposing the joint distribution over c-components and applying formulas such as those of Tian and Pearl.',
    expectedEntities: [{ name: 'C-component', type: 'Concept' }],
    difficulty: 'hard',
  },
  {
    shard: 'SHD_CORE_GRAPH_005',
    question: 'What is the master equation used for in network and system modeling?',
    expectedAnswer:
      'The master equation describes the time evolution of the probability distribution over system states in terms of transition rates between states. It provides the stochastic-dynamics foundation for how probability mass flows through a state space (or a network of stocks), from which aggregate dynamics and stationary distributions can be derived.',
    expectedEntities: [{ name: 'Master Equation', type: 'Concept' }],
    difficulty: 'medium',
  },
  // ===== SHD_COMPLEXITY_006 — Độ phức tạp =====
  {
    shard: 'SHD_COMPLEXITY_006',
    question: 'Compare small-world networks and scale-free networks.',
    expectedAnswer:
      'Small-world networks combine high local clustering with short average path lengths (Watts-Strogatz rewiring), so information spreads quickly while neighborhoods stay dense. Scale-free networks have power-law (heavy-tailed) degree distributions dominated by a few hubs, typically formed by preferential attachment (Barabási-Albert). Both describe real complex systems but capture different structural signatures.',
    expectedEntities: [
      { name: 'Small-world Networks', type: 'Concept' },
      { name: 'Scale-free Networks', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_COMPLEXITY_006',
    question: 'What is self-similarity in fractals?',
    expectedAnswer:
      'Self-similarity means a structure repeats the same pattern across different scales: zooming in reveals shapes statistically or exactly similar to the whole. Fractals embody this property with non-integer (fractional) dimensions, and scale-invariant, heavy-tailed distributions often accompany self-similar structure in natural systems.',
    expectedEntities: [
      { name: 'Fractals', type: 'Concept' },
      { name: 'Self-similarity', type: 'Principle' },
    ],
    difficulty: 'easy',
  },
  {
    shard: 'SHD_COMPLEXITY_006',
    question: 'Explain emergence and the role of feedback loops in complex systems.',
    expectedAnswer:
      'Emergence is the appearance of novel system-level behavior arising from local interactions of many agents — order that is not present in, nor directly predictable from, the individual components. Feedback loops drive this: positive loops amplify deviations and can produce tipping points, while negative loops stabilize; their interplay lets adaptive agents self-organize into collective patterns.',
    expectedEntities: [
      { name: 'Emergence', type: 'Concept' },
      { name: 'Feedback Loops', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  // ===== SHD_DSL_007 — Data science & learning dynamics =====
  {
    shard: 'SHD_DSL_007',
    question: 'Walk through Bayesian inference: prior, likelihood and posterior.',
    expectedAnswer:
      'Bayesian inference updates beliefs by combining a prior probability over hypotheses with the likelihood of observed data given each hypothesis, yielding the posterior distribution via Bayes rule (posterior proportional to likelihood times prior). Latent variables in a DAG structure formalize the dependencies, and conjugate families such as the Gaussian distribution allow closed-form updates.',
    expectedEntities: [
      { name: 'Bayesian Inference', type: 'Concept' },
      { name: 'Prior Probability', type: 'Concept' },
      { name: 'Posterior Distribution', type: 'Concept' },
    ],
    difficulty: 'easy',
  },
  {
    shard: 'SHD_DSL_007',
    question: 'What is backpropagation and why is the loss function central to training neural networks?',
    expectedAnswer:
      'Backpropagation applies the chain rule to compute the gradient of the loss function with respect to every weight in the network, propagating error signals backward layer by layer. The loss function quantifies the mismatch between predictions and targets; gradient descent then iteratively updates the weights to minimize it — the whole learning process is driven by the choice of loss.',
    expectedEntities: [
      { name: 'Backpropagation', type: 'Algorithm' },
      { name: 'Loss Function', type: 'Concept' },
    ],
    difficulty: 'easy',
  },
  {
    shard: 'SHD_DSL_007',
    question: 'Distinguish parameters/weights from hyperparameters in machine learning.',
    expectedAnswer:
      'Parameters (weights) are the values the model learns from data during training via gradient-based optimization of the loss. Hyperparameters (learning rate, network depth, regularization strength) are set before training and control the learning process itself; selecting them is an outer tuning loop, typically using heuristics or systematic search.',
    expectedEntities: [
      { name: 'Weights/Parameters', type: 'Concept' },
      { name: 'Hyperparameters', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  // ===== SHD_GTH_008 — Lý thuyết trò chơi =====
  {
    shard: 'SHD_GTH_008',
    question: 'What is a Nash equilibrium in game theory?',
    expectedAnswer:
      'A Nash equilibrium is a strategy profile in which no player can improve their payoff by unilaterally deviating from their strategy, given the strategies of the others. It can involve pure strategies or mixed strategies (probability distributions over actions), and Nash theorem guarantees at least one mixed-strategy equilibrium in every finite game. It is the central solution concept for predicting stable outcomes of strategic interaction.',
    expectedEntities: [{ name: 'Nash Equilibrium', type: 'Concept' }],
    difficulty: 'easy',
  },
  {
    shard: 'SHD_GTH_008',
    question: 'Explain dominant strategy versus best response.',
    expectedAnswer:
      'A best response is a strategy that is optimal given the specific strategies chosen by the other players; it is conditional on opponents play. A dominant strategy is optimal no matter what the opponents do — it is a best response to every possible opposing strategy profile. Dominance is stronger: iterated elimination of dominated strategies can progressively simplify the game toward equilibrium.',
    expectedEntities: [
      { name: 'Dominant Strategy', type: 'Concept' },
      { name: 'Best Response', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  {
    shard: 'SHD_GTH_008',
    question: 'What is the difference between a pure strategy and a mixed strategy?',
    expectedAnswer:
      'A pure strategy deterministically selects one action from the strategy space, while a mixed strategy randomizes over several pure strategies according to a probability distribution. Games in extensive form or normal form (payoff matrix) can both admit mixed equilibria; some games — like matching pennies or rock-paper-scissors — only have equilibria in mixed strategies.',
    expectedEntities: [
      { name: 'Pure Strategy', type: 'Concept' },
      { name: 'Mixed Strategy', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  // ===== PSY-CORE-SCI-009 — Tâm lý học =====
  {
    shard: 'PSY-CORE-SCI-009',
    question: 'What is the paradox of choice and how do maximizers differ from satisficers?',
    expectedAnswer:
      'The paradox of choice says that although freedom of choice is valuable, having too many options can paralyze decision-making and reduce satisfaction. Maximizers search for the absolutely best option — they examine every alternative and feel satisfied only with the optimum, incurring high psychological pressure. Satisficers look for options that are "good enough" by their personal standards and stop searching once those standards are met, experiencing less regret and decision stress.',
    expectedEntities: [
      { name: 'Paradox of Choice', type: 'Concept' },
      { name: 'Maximizer', type: 'Concept' },
      { name: 'Satisficer', type: 'Concept' },
    ],
    difficulty: 'medium',
  },
  {
    shard: 'PSY-CORE-SCI-009',
    question: 'Explain the peak-end rule of memory.',
    expectedAnswer:
      'The peak-end rule states that our memory of an experience is determined mainly by the emotion we felt at its most intense point (the peak, whether pleasant or unpleasant) and at its end — not by its duration or the average of every moment. As a result, evaluations of past experiences can be biased toward these two moments when making future decisions.',
    expectedEntities: [{ name: 'Peak-End Rule', type: 'Principle' }],
    difficulty: 'easy',
  },
  {
    shard: 'PSY-CORE-SCI-009',
    question: 'What is learned helplessness in psychology?',
    expectedAnswer:
      'Learned helplessness is a passive state that occurs when a person comes to believe they have no control over negative events happening to them. Repeated exposure to uncontrollable stressors leads to loss of motivation and can contribute to depression, because the individual stops attempting to change the situation even when control becomes available.',
    expectedEntities: [{ name: 'Learned Helplessness', type: 'Concept' }],
    difficulty: 'easy',
  },
]

async function main() {
  console.log('[SeedEvalKnowledge] Starting — 27 case knowledge-domain khớp corpus 9 shard D0...')
  let inserted = 0
  let skipped = 0

  for (const c of CASES) {
    const existing = await db.evalCase.findFirst({ where: { question: c.question } })
    if (existing) {
      skipped++
      continue
    }
    await db.evalCase.create({
      data: {
        question: c.question,
        expectedAnswer: c.expectedAnswer,
        expectedEntities: JSON.stringify(c.expectedEntities),
        category: 'knowledge',
        difficulty: c.difficulty,
        source: 'd0_corpus',
      },
    })
    inserted++
    console.log(`[SeedEvalKnowledge] + [${c.shard}] (${c.difficulty}) ${c.question.slice(0, 70)}...`)
  }

  const total = await db.evalCase.count({ where: { category: 'knowledge' } })
  console.log(`[SeedEvalKnowledge] DONE — inserted=${inserted} skipped=${skipped} · tổng EvalCase knowledge=${total}`)

  // Phân bố theo shard cho log kiểm tra
  const byShard = new Map<string, number>()
  for (const c of CASES) byShard.set(c.shard, (byShard.get(c.shard) ?? 0) + 1)
  console.log('[SeedEvalKnowledge] Phủ shard:', JSON.stringify([...byShard.entries()]))

  process.exit(0)
}

main().catch((err) => {
  console.error('[SeedEvalKnowledge] FAIL:', err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
