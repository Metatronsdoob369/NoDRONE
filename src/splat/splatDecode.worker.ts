import { parseSplatCloud, type SplatFileFormat } from './splatthatLoader';

interface DecodeRequest {
  buffer: ArrayBuffer;
  format: SplatFileFormat | 'auto';
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { buffer, format } = event.data;
  void parseSplatCloud(buffer, format)
    .then((cloud) => {
      scope.postMessage(
        { ok: true, cloud },
        [cloud.positions.buffer, cloud.scales.buffer, cloud.rotations.buffer, cloud.colors.buffer]
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      scope.postMessage({ ok: false, message }, []);
    });
};
