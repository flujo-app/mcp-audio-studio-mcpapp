export function encodeAudioBufferAsWav(audio: AudioBuffer): ArrayBuffer {
  const channels = Math.max(1, Math.min(2, audio.numberOfChannels));
  const frames = audio.length;
  const buffer = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, data[channel][frame]));
      view.setInt16(offset, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
      offset += 2;
    }
  }
  return buffer;
}

export async function normalizeAudioFileToWav(file: File): Promise<File> {
  if (file.type.toLowerCase() === "audio/wav" || /\.wav$/i.test(file.name)) return file;
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const wav = encodeAudioBufferAsWav(decoded);
    return new File([wav], file.name.replace(/\.[^.]+$/, "") + ".wav", { type: "audio/wav" });
  } finally {
    await context.close();
  }
}
