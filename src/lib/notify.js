let audioContext = null;

export function playChime() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    [880, 1320].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.18, now + index * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.14 + 0.3);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + index * 0.14);
      oscillator.stop(now + index * 0.14 + 0.32);
    });
  } catch { /* audio is best effort */ }
}

export async function requestBrowserNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export function browserNotify(title, body, onClick) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  const notification = new Notification(title, { body, tag: 'autexa-handoff' });
  notification.onclick = () => { window.focus(); onClick?.(); notification.close(); };
}
