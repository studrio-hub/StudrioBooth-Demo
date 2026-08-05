/*
 * UI-ANIMATIONS.JS
 * Global GSAP-driven interactions for buttons and UI elements.
 */

const uiAnimations = {
  init() {
    this.initButtons();
    this.initCards();
  },

  initButtons() {
    // Add slide/fill effect to all buttons via GSAP
    const buttons = document.querySelectorAll('.btn');
    if (buttons.length > 0) {
      buttons.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
          gsap.to(btn, { scale: 1.02, duration: 0.3, ease: "power2.out" });
        });

        btn.addEventListener('mouseleave', () => {
          gsap.to(btn, { scale: 1, duration: 0.3, ease: "power2.out" });
        });

        btn.addEventListener('mousedown', () => {
          gsap.to(btn, { scale: 0.96, duration: 0.1 });
        });

        btn.addEventListener('mouseup', () => {
          gsap.to(btn, { scale: 1.02, duration: 0.2 });
        });
      });
    }
  },

  initCards() {
    // Selection cards (Page 4)
    const cards = document.querySelectorAll('.photo-card');
    if (cards.length > 0) {
      cards.forEach(card => {
        card.addEventListener('click', () => {
          if (card.classList.contains('selected')) {
            gsap.fromTo(card, 
              { scale: 1 }, 
              { scale: 1.05, duration: 0.3, yoyo: true, repeat: 1, ease: "back.out(2)" }
            );
          }
        });
      });
    }
  },

  // Reveal page elements with a stagger
  animatePageIn(pageEl) {
    if (!pageEl) return;
    const elements = pageEl.querySelectorAll('.page-title, .design-grid, .btn, .accent-line');
    if (elements.length > 0) {
      gsap.from(elements, {
        opacity: 0,
        y: 20,
        duration: 0.6,
        stagger: 0.1,
        ease: "power3.out",
        clearProps: "all"
      });
    }
  }
};

// Hook into the goToPage function from app.js if possible, 
// or just run on DOMContentLoaded for the initial page.
document.addEventListener('DOMContentLoaded', () => {
  uiAnimations.init();
});
