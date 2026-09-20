// Deliberately broken process, confined to tests. It ignores SIGTERM to prove hard cancellation.
process.on('SIGTERM', () => {});
process.once('message', () => {
  if (process.env.AUDIT_WORKER_BEHAVIOR === 'crash') process.exit(71);
  for (;;) {
    /* uncooperative synchronous connector */
  }
});
process.send?.({ type: 'ready' });
