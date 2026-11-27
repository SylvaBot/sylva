//! Text to speech for tips: measuring the stand-in voice's MP3, so an alert
//! stays up while its message is read.

/// How long an MP3 plays, in milliseconds, from its frame headers. None
/// when no frames are found.
pub fn mp3_ms(data: &[u8]) -> Option<u32> {
    let mut i = 0;
    // Skip an ID3v2 tag.
    if data.len() > 10 && &data[..3] == b"ID3" {
        let size = data[6..10]
            .iter()
            .fold(0usize, |n, b| (n << 7) | (*b as usize & 0x7f));
        i = 10 + size;
    }
    const RATES_V1: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const RATES_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let mut micros: u64 = 0;
    let mut frames = 0;
    while i + 4 <= data.len() {
        let h = &data[i..i + 4];
        let version = (h[1] >> 3) & 3; // 3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5
        let layer = (h[1] >> 1) & 3; // 1: Layer III
        let rate_i = (h[2] >> 4) as usize;
        let freq_i = ((h[2] >> 2) & 3) as usize;
        if h[0] != 0xff || h[1] & 0xe0 != 0xe0 || version == 1 || layer != 1 || rate_i == 0 || rate_i == 15 || freq_i == 3 {
            i += 1;
            continue;
        }
        let base = [44_100u32, 48_000, 32_000][freq_i];
        let (freq, kbps, samples, coef) = match version {
            3 => (base, RATES_V1[rate_i], 1152u32, 144u32),
            2 => (base / 2, RATES_V2[rate_i], 576, 72),
            _ => (base / 4, RATES_V2[rate_i], 576, 72),
        };
        let pad = ((h[2] >> 1) & 1) as u32;
        let len = (coef * kbps * 1000 / freq + pad) as usize;
        micros += samples as u64 * 1_000_000 / freq as u64;
        frames += 1;
        i += len.max(1);
    }
    (frames > 0).then(|| (micros / 1000) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_mp3() {
        // 100 frames of MPEG 2 Layer III, 24 kHz, 48 kbps: 576 samples
        // and 144 bytes each, 2.4 seconds in all.
        let mut frame = vec![0u8; 144];
        frame[..4].copy_from_slice(&[0xff, 0xf3, 0x64, 0xc4]);
        let mut data = b"ID3\x03\x00\x00\x00\x00\x00\x02xx".to_vec();
        for _ in 0..100 {
            data.extend_from_slice(&frame);
        }
        assert_eq!(mp3_ms(&data), Some(2400));
        assert_eq!(mp3_ms(b"not audio"), None);
    }
}
