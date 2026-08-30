const worker = globalThis;

worker.addEventListener("install", () => {
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await worker.clients.claim();
      const windows = await worker.clients.matchAll({ type: "window" });
      await Promise.allSettled(
        windows.map((client) => client.navigate(client.url)),
      );
    })(),
  );
});
