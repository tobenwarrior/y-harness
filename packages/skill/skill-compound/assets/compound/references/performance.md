# Performance

Define a user-relevant metric, representative workload, environment, and baseline before optimizing. Separate warm-up, setup, I/O, and the work being measured. Use enough repetitions to expose variation.

Profile or instrument to find the limiting mechanism. Change one explanatory factor, repeat the same workload, and check correctness alongside speed. Keep a change only when its benefit justifies its complexity.

Report before and after values, units, workload, environment, variation, and the mechanism changed. Label estimates and synthetic results. A faster benchmark that performs less required work, moves cost elsewhere, or measures a different path does not establish an improvement.
