export interface RecordedVideoResult {
  blob: Blob;
  mimeType: string;
  filename: string;
  durationMs: number;
}

const CANDIDATE_VIDEO_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export class ReplayVideoRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private activeMimeType = '';
  private startedAtMs = 0;
  private stopPromise: Promise<RecordedVideoResult | null> | null = null;

  public static isSupported(): boolean {
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
      return false;
    }
    const proto = typeof HTMLCanvasElement !== 'undefined' ? HTMLCanvasElement.prototype : null;
    if (!proto || typeof (proto as { captureStream?: unknown }).captureStream !== 'function') {
      return false;
    }
    return ReplayVideoRecorder.getSupportedMimeType() !== null;
  }

  public static getSupportedMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return null;
    }
    for (const mime of CANDIDATE_VIDEO_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return '';
  }

  public isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  public startRecording(canvas: HTMLCanvasElement, filenamePrefix = 'ultimate-pool-replay'): boolean {
    if (this.isRecording()) return true;
    const mime = ReplayVideoRecorder.getSupportedMimeType();
    if (mime === null) return false;
    const captureFn = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream })
      .captureStream;
    if (typeof captureFn !== 'function') return false;

    try {
      const stream = captureFn.call(canvas, 30);
      const options: MediaRecorderOptions = mime ? { mimeType: mime } : {};
      const recorder = new MediaRecorder(stream, options);
      this.stream = stream;
      this.recorder = recorder;
      this.chunks = [];
      this.activeMimeType = recorder.mimeType || mime || 'video/webm';
      this.startedAtMs = Date.now();
      this.stopPromise = new Promise<RecordedVideoResult | null>((resolve) => {
        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            this.chunks.push(ev.data);
          }
        };
        recorder.onstop = () => {
          const durationMs = Math.max(0, Date.now() - this.startedAtMs);
          const mimeOut = this.activeMimeType || 'video/webm';
          const ext = mimeOut.includes('mp4') ? 'mp4' : 'webm';
          const blob = new Blob(this.chunks, { type: mimeOut });
          const filename = `${filenamePrefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
          this.cleanupTracks();
          resolve({ blob, mimeType: mimeOut, filename, durationMs });
        };
        recorder.onerror = () => {
          this.cleanupTracks();
          resolve(null);
        };
      });
      recorder.start(250);
      return true;
    } catch {
      this.cleanupTracks();
      return false;
    }
  }

  public async stopRecording(): Promise<RecordedVideoResult | null> {
    if (!this.recorder) return null;
    const pending = this.stopPromise;
    try {
      if (this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
    } catch {
      this.cleanupTracks();
      return null;
    }
    return pending ? await pending : null;
  }

  public dispose(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // Ignore
      }
    }
    this.cleanupTracks();
  }

  private cleanupTracks(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
    }
    this.stream = null;
    this.recorder = null;
    this.stopPromise = null;
  }
}

export function downloadRecordedVideo(res: RecordedVideoResult): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const url = URL.createObjectURL(res.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
