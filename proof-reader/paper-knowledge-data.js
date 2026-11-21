window.PAPER_KNOWLEDGE_DATA = {
  intervals: {
    techniques: [
      {
        id: "greedy-exchange",
        name: "Greedy exchange argument",
        selfCheck: {question: "A replacement preserves feasibility and the number of chosen items. Is that enough to justify it for an objective that sums unequal rewards?", answer: "The replacement must also preserve or improve total reward. Replacing one feasible item worth 10 with one worth 1 preserves the count but loses 9 reward units."},
        mechanism: "Take an optimal solution and exchange one chosen object for the algorithm's first choice. If feasibility and the objective survive, some optimal solution starts with the greedy choice.",
        steps: [1, 2],
        knownBridge: "Here only the finish times matter for feasibility, and replacing one activity preserves the count. Recheck the objective if the activities carry different rewards.",
        folklore: true,
        sources: [],
        aliases: ["Greedy-choice exchange argument"],
        planningSkills: ["Exchange argument"]
      },
      {
        id: "induction-on-the-residual-instance",
        name: "Induction on the remaining instance",
        selfCheck: {question: "A recursive call can leave the same number of candidates as its parent. Can the induction hypothesis on strictly smaller candidate counts justify that call?", answer: "No. Prove a strict decrease for every non-base case, or find a different well-founded parameter that decreases."},
        mechanism: "On empty input, greedy takes zero activities and is optimal. After fixing a safe choice, the remaining candidates form a smaller instance of the same problem. By induction, greedy solves that instance optimally. Appending its solution to the safe choice gives an optimal schedule.",
        steps: [3],
        knownBridge: "An activity beginning exactly when G ends belongs in the suffix. Check that G itself is removed because its length is positive, so the induction parameter decreases.",
        folklore: true,
        sources: [],
        planningSkills: ["Induction"]
      }
    ],
    definitionGroups: [
      {
        id: "interval-input", title: "Intervals and feasibility", steps: [1, 2, 3],
        selfCheck: {question: "Can a single machine take both [1, 3) and [3, 4)?", answer: "Yes. The first activity releases the machine at 3, exactly when the second activity starts. Their occupied times do not overlap."},
        definitions: [
          {term: "Half-open interval", meaning: "The interval [s, f) contains its start s and excludes its finish f. A second interval may start exactly at f without overlapping it."},
          {term: "Compatible activities", meaning: "Two activities can share one machine if their intervals do not overlap. A feasible schedule consists of pairwise compatible activities."},
          {term: "Maximum cardinality", meaning: "Each selected item adds one to the objective. An optimal feasible set has the largest possible number of items."}
        ]
      }
    ],
    parts: [
      {id: "choice", title: "Make the first choice", sourceSteps: [1],
        orientation: {
          introduction: "One machine must choose among activities with fixed times, and each activity it completes counts once. A natural first choice is the activity that frees the machine soonest. The question is whether making that choice can ever reduce the best attainable count.",
          notation: [
            {symbol: "\\(S,I\\)", meaning: "The finite set of candidate activities and a single activity in it."},
            {symbol: "\\(s(I),f(I)\\)", meaning: "The fixed start and finish times of activity \\(I\\), with \\(s(I)<f(I)\\)."},
            {symbol: "\\(G\\)", meaning: "Any candidate with the earliest finish in the current instance."}
          ],
          definitions: [
            {name: "Feasible schedule", text: "A set of activities whose half-open intervals \\([s(I),f(I))\\) are pairwise disjoint. An activity may start at the instant another finishes."},
            {name: "Maximum cardinality", text: "An optimum is a feasible schedule containing as many activities as possible. Each selected activity contributes one."}
          ],
          paragraphs: [
            "Sort the activities by increasing finish time, breaking ties arbitrarily. Accept the first one, if there is one. Scan the rest in that order and accept each activity whose start is at least the finish of the last accepted activity.",
            "The first accepted activity \\(G\\) frees the machine no later than any competing first activity. For example, on \\([0,4),[1,2),[2,3)\\), choosing the earliest finish leaves room for a second activity. Choosing the earliest start gives only the long activity. The finish-time comparison suggests how to prove the greedy choice is safe for every input."
          ],
          handoff: "To justify this choice, the next part looks for a maximum-cardinality schedule that can begin with it.",
          statement: null
        },
        summary: "On one machine, schedule as many positive-length activities as possible. Select an available activity G with the earliest finish. This leaves the machine free as early as any first choice could.",
        techniqueIds: [], definitionGroupIds: ["interval-input"], localPrerequisiteIds: []},
      {id: "exchange", title: "Find an optimum that starts with G", sourceSteps: [2],
        orientation: {
          introduction: "Fix a nonempty set of activities. To prove that the earliest finish is a safe first choice, start with a schedule known to be optimal and change its first activity. The proof succeeds if the same number of activities still fits on the machine.",
          notation: [
            {symbol: "\\(G,O,X\\)", meaning: "An earliest-finishing activity, an optimal schedule ordered by time, and the first activity of that schedule."},
            {symbol: "\\(s(Y),f(Y)\\)", meaning: "Fixed start and finish of any activity \\(Y\\)."}
          ],
          definitions: [
            {name: "Safe first choice", text: "A choice is safe if at least one maximum-cardinality feasible schedule begins with it.", intuition: "The algorithm can commit to this choice without reducing how many activities it can ultimately take."}
          ],
          paragraphs: [
            "If \\(X=G\\), the chosen optimum already has the desired first activity. Otherwise \\(f(G)\\le f(X)\\) by the greedy rule. Nor can \\(G\\) occur later in \\(O\\). Any later activity starts at or after \\(f(X)\\) and has positive length, so it finishes strictly after \\(f(X)\\).",
            "Replace \\(X\\) with \\(G\\). Every later activity \\(Y\\) still fits, since \\(s(Y)\\ge f(X)\\ge f(G)\\). The exchange removes one activity and adds one, so the resulting feasible schedule has the same count as \\(O\\). It is an optimum beginning with \\(G\\), including when the two finish times tie."
          ],
          handoff: "Some optimum now starts with \\(G\\), so the proof can fix that choice and concentrate on the suffix.",
          statement: null
        },
        summary: "Take any optimal schedule and replace its first activity X with G. Every later activity begins at or after f(X), hence at or after f(G). The schedule keeps the same suffix and the same count.",
        techniqueIds: ["greedy-exchange"], definitionGroupIds: ["interval-input"], localPrerequisiteIds: ["earliest-finish"]},
      {id: "suffix", title: "Solve the remaining instance", sourceSteps: [3],
        orientation: {
          introduction: "The exchange proves that one greedy choice can begin an optimum. To justify the whole sequence, identify the exact problem left after that choice and show it is the same scheduling problem on fewer candidates.",
          notation: [
            {symbol: "\\(S,G\\)", meaning: "The current finite candidate set and an activity in it with earliest finish."},
            {symbol: "\\(s(I),f(G)\\)", meaning: "Start of a candidate activity and finish of the chosen activity."},
            {symbol: "\\(S'\\)", meaning: "The residual candidate set after selecting \\(G\\)."}
          ],
          definitions: [
            {name: "Residual instance", text: "The set \\(S'=\\{I\\in S:s(I)\\ge f(G)\\}\\) has the original fixed intervals and the same objective of maximizing the number of pairwise compatible activities."}
          ],
          paragraphs: [
            "By the exchange, some optimum starts with \\(G\\). Every activity after \\(G\\) belongs to \\(S'\\), and every feasible schedule in \\(S'\\) may follow \\(G\\). Its chosen suffix must therefore be optimal in \\(S'\\). Otherwise a longer suffix could replace it to improve the original optimum.",
            "Induct on the number of candidates. An empty set has optimum zero, which greedy attains. For a nonempty set, \\(s(G)<f(G)\\), so \\(G\\) itself is absent from \\(S'\\) and the set gets strictly smaller. By induction the repeated greedy rule finds an optimal suffix. Prepending \\(G\\) gives a schedule of maximum cardinality."
          ],
          handoff: "The finish-time scan implements that induction in one pass through the sorted activities. Each accepted activity sets the earliest start allowed for the next one.",
          statement: null
        },
        summary: "Keep the candidates starting at or after the finish of G. This smaller instance has the same feasibility rule and objective. Since some optimum already starts with G, an optimal greedy suffix completes the argument.",
        techniqueIds: ["induction-on-the-residual-instance"], definitionGroupIds: [], localPrerequisiteIds: ["safe-choice"]}
    ],
    localIntroductions: [
      {id: "earliest-finish", originPartId: "choice", kind: "definition", title: "The first activity G",
        meaning: "Among the current candidates choose any G minimizing f(G). Activities have fixed, positive-length, half-open intervals, and each contributes exactly one to the objective. Earliest start would not give this finish-time inequality."},
      {id: "safe-choice", originPartId: "exchange", kind: "lemma", title: "An optimal schedule starts with G",
        meaning: "Let X be the first activity in an optimal schedule O. Every activity in its suffix starts at or after f(X), and f(G) ≤ f(X). Replacing X by G keeps all later activities feasible and preserves cardinality. The argument can fail for unequal rewards."},
      {id: "residual-instance", originPartId: "suffix", kind: "definition", title: "The remaining candidates S′",
        meaning: "S′ contains exactly those candidates starting at or after f(G). A candidate starting at f(G) is allowed. G has positive length, so G itself is removed and the number of candidates decreases."}
    ]
  }
};
