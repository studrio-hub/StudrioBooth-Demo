/*
 * KIOSK-TIMER.JS — shared 60-second circular countdown, reused across
 * Pages 2, 4, 5, and 6. Each page calls kioskTimer.start(seconds, onExpire)
 * when it becomes active, and kioskTimer.hide() when the guest moves on
 * manually (so a stale timer never keeps ticking into the next page).
 */

const kioskTimer = {
  el: document.getElementById("kioskTimer"),
  numberEl: document.getElementById("kioskTimerNumber"),
  progressEl: document.getElementById("kioskTimerProgress"),
  radius: 45,
  circumference: 0,
  intervalId: null,
  duration: 60,
  remaining: 60,
  onExpire: null,

  _init() {
    this.circumference = 2 * Math.PI * this.radius;
    this.progressEl.style.strokeDasharray = `${this.circumference}`;
    this.progressEl.style.strokeDashoffset = "0";
  },

  start(seconds, onExpire) {
    this.stop();
    this.duration = seconds;
    this.remaining = seconds;
    this.onExpire = onExpire;
    this.el.hidden = false;
    this._render();
    this.intervalId = setInterval(() => {
      this.remaining -= 1;
      this._render();
      if (this.remaining <= 0) {
        this.stop();
        this.el.hidden = true;
        const cb = this.onExpire;
        this.onExpire = null;
        if (cb) cb();
      }
    }, 1000);
  },

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  },

  hide() {
    this.stop();
    this.onExpire = null;
    this.el.hidden = true;
  },

  _render() {
    const clamped = Math.max(0, this.remaining);
    this.numberEl.textContent = clamped;
    const fraction = this.duration > 0 ? clamped / this.duration : 0;
    this.progressEl.style.strokeDashoffset = `${this.circumference * (1 - fraction)}`;
  }
};

kioskTimer._init();