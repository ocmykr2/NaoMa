window.PROOF_DEMO = {
  title: "A greedy proof for interval scheduling",
  subtitle: "Given finitely many positive-length, half-open intervals [s, f), how many activities can one machine schedule without overlap?",
  techniques: ["Greedy choice", "Exchange argument", "Induction"],
  steps: [
    {
      title: "Which activity comes first?",
      technique: "Greedy choice",
      source: "Sort the activities by finish time and take the first one. Scan the rest in order, accepting each activity that starts when the machine is free. Ties in finish time may be broken arbitrarily.",
      summary: "Every activity counts equally. Among the feasible choices, the earliest finish leaves the machine available for the longest remaining time.",
      options: [
        {
          label: "Run the rule on three activities",
          body: "Scan A, B, and C in order of finish time. A and B fit back to back, giving a schedule of two activities.",
          targets: [
            { label: "When the machine becomes free", body: "A occupies the half-open interval [0, 2), so the machine becomes free at time 2. B starts exactly then. After accepting B, the next activity can start as early as 3." },
            { label: "Why C is skipped", body: "C has the fixed interval [1, 4). After accepting A and B, the machine next becomes free at 3. C needs it at 1. Moving C to time 3 would change the input." },
          ],
          table: {
            head: ["Activity", "Interval", "Decision"],
            rows: [
              ["A", "[0, 2)", "Accept. Next free at 2."],
              ["B", "[2, 3)", "Accept. Next free at 3."],
              ["C", "[1, 4)", "Skip. Its start time 1 precedes 3."],
            ],
          },
        },
        {
          label: "What if we take the earliest start?",
          body: "Consider [0, 4), [1, 2), and [2, 3). Earliest start takes [0, 4) and can schedule only one activity. Earliest finish takes [1, 2) followed by [2, 3), scheduling two.",
        },
        {
          label: "Can two activities share an endpoint?",
          body: "Yes. For [0, 2) and [2, 3), only the second activity occupies time 2. The next start must satisfy start ≥ previous finish. With closed intervals and no shared endpoints allowed, the condition becomes start > previous finish.",
        },
      ],
    },
    {
      title: "Why can we replace the first activity in an optimum?",
      technique: "Exchange argument",
      source: "Let G be an activity with the earliest finish in a nonempty instance. Take an optimal schedule O and call its first activity X. If X is G, we are done. Otherwise replace X with G. Since f(G) ≤ f(X), every later activity still fits, and the count stays the same. Thus some optimal schedule begins with G.",
      summary: "Exchange X for G. The inequality f(G) ≤ f(X) preserves feasibility for the entire suffix. Replacing one activity with one activity preserves the objective.",
      options: [
        {
          label: "See an exchange that changes the schedule",
          body: "The only activities are X, G, and R. X overlaps G, so at most two fit. Start with the optimal pair X, R. After exchanging X for G, the pair G, R still fits.",
          targets: [
            { label: "The activity X that leaves", body: "X occupies [0, 3) and G occupies [1, 2). They overlap throughout [1, 2), so taking G requires dropping X. Each contributes one activity. The schedule still has two." },
            { label: "The activity R that stays", body: "R occupies the half-open interval [3, 4). X finishes at 3 and its replacement G finishes at 2. In either case, R can keep its original start time of 3." },
          ],
          table: {
            head: ["Activity", "Interval", "Before", "After"],
            rows: [
              ["X", "[0, 3)", "First", "Removed"],
              ["G", "[1, 2)", "Absent", "First"],
              ["R", "[3, 4)", "Second", "Second"],
            ],
          },
        },
        {
          label: "Why compare only finish times?",
          body: "For every later activity Y, the old schedule gives s(Y) ≥ f(X). Combining this with f(X) ≥ f(G) gives s(Y) ≥ f(G). The start of G causes no conflict because G goes first. If X was the only activity, there is no suffix to check.",
        },
        {
          label: "Where does Kruskal use a similar exchange?",
          body: "Both arguments insert the greedy choice and check what survives the exchange. Here the later activities still fit and the count is unchanged. The safe-edge lemma used by Kruskal must preserve a spanning tree. The textbook assumes distinct edge weights. If a tree omits the lightest edge across a cut, replace a heavier crossing edge on the tree path between its endpoints. The result is still a tree and its total weight is smaller.",
          reference: { label: "Jeff Erickson, Algorithms, Chapter 7, Lemma 7.2", url: "https://jeffe.cs.illinois.edu/teaching/algorithms/book/07-mst.pdf" },
        },
        {
          label: "What breaks if activities have rewards?",
          body: "Suppose [0, 2) earns 1 and [1, 3) earns 10. These activities overlap. Replacing the second with the earlier-finishing first preserves the count of 1 and reduces the reward from 10 to 1. The exchange no longer preserves the objective.",
        },
      ],
    },
    {
      title: "How does one safe choice yield an optimal schedule?",
      technique: "Induction",
      source: "After fixing G, let S′ contain every activity I with s(I) ≥ f(G). The previous step gives an optimal schedule starting with G. Its suffix must be optimal for S′, since any longer suffix could follow G and improve the schedule. The empty instance is optimal by inspection. Since S′ is smaller, induction on the number of activities gives an optimal greedy suffix. Prepending G completes the proof.",
      summary: "Induct on the candidate count. Fixing G removes at least G itself. The remaining instance is smaller and has the same objective and feasibility rule.",
      options: [
        {
          label: "Trace the remaining candidates",
          body: "Take A=[0, 2), B=[1, 4), C=[2, 3), and D=[3, 5). Each row takes the earliest finish among the current candidates.",
          targets: [
            { label: "Why C and D survive the first round", body: "A finishes at 2, so retain every activity starting at 2 or later. B starts at 1, C at 2, and D at 3. The remaining set is {C, D}." },
            { label: "Why the last round leaves an empty set", body: "D is the last activity and occupies the half-open interval [3, 5). No candidate starts at 5 or later. The remaining optimum is 0, and the full run accepts three activities, A, C, and D." },
          ],
          table: {
            head: ["Candidates", "Accepted", "Next round"],
            rows: [
              ["A, B, C, D", "A finishes at 2", "C, D. B starts at 1."],
              ["C, D", "C finishes at 3", "D starts exactly at 3."],
              ["D", "D finishes at 5", "Empty set"],
            ],
          },
        },
        {
          label: "Why must the suffix itself be optimal?",
          body: "Suppose the suffix in an optimal schedule starting with G contains k activities, but S′ admits k+1. Every activity in S′ starts at or after the finish of G. Appending the longer suffix to G increases the total by 1, contradicting optimality.",
        },
        {
          label: "What if there are no activities?",
          body: "The algorithm stops immediately with 0 activities, the optimum for the empty set. On any nonempty instance, at least G leaves the candidate set because its start is strictly earlier than its finish. This strictly decreases the size used in the induction.",
        },
      ],
    },
  ],
};
