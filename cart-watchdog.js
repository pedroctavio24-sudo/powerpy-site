/**
 * POWER PY — Cart Watchdog
 * Se o carrinho tiver produtos e nao for pago em 5 min → popup urgência → reset
 */
(function() {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
  const WARN_MS    = 60 * 1000;     // aviso 1 min antes
  const KEY_TS     = 'pp_cart_ts';  // timestamp de quando o carrinho foi preenchido
  const KEY_CART   = 'pp_cart';
  const KEY_ORDER  = 'pp_order';
  const KEY_PAID   = 'pp_cart_paid';

  // Não roda em confirmacao.html
  if (location.pathname.includes('confirmacao')) return;

  function cartHasItems() {
    try {
      const c = JSON.parse(localStorage.getItem(KEY_CART) || '[]');
      return c.length > 0;
    } catch(e) { return false; }
  }

  function isPaid() {
    return localStorage.getItem(KEY_PAID) === '1';
  }

  function resetCart() {
    localStorage.removeItem(KEY_CART);
    localStorage.removeItem(KEY_ORDER);
    localStorage.removeItem(KEY_TS);
    localStorage.removeItem(KEY_PAID);
  }

  function startTimer() {
    if (!cartHasItems()) return;
    if (isPaid()) return;
    const existing = localStorage.getItem(KEY_TS);
    if (!existing) {
      localStorage.setItem(KEY_TS, Date.now().toString());
    }
  }

  function injectModal() {
    if (document.getElementById('pp-watchdog-modal')) return;

    const style = document.createElement('style');
    style.textContent = `
      #pp-watchdog-modal {
        display:none;position:fixed;inset:0;z-index:999999;
        background:rgba(0,0,0,0.88);backdrop-filter:blur(6px);
        align-items:center;justify-content:center;
      }
      #pp-watchdog-modal.active { display:flex; }
      #pp-watchdog-box {
        background:#0d0f14;border:2px solid #e53e3e;
        width:min(420px,94vw);padding:40px 32px;text-align:center;
        font-family:'Bebas Neue','Impact',sans-serif;
        animation: ppwdshake .4s ease;
      }
      @keyframes ppwdshake {
        0%{transform:scale(.92) rotate(-1deg)}
        50%{transform:scale(1.03) rotate(.5deg)}
        100%{transform:scale(1) rotate(0)}
      }
      #pp-watchdog-box .wd-icon { font-size:48px; margin-bottom:12px; }
      #pp-watchdog-box .wd-title {
        font-size:32px;color:#e53e3e;letter-spacing:4px;
        text-transform:uppercase;line-height:1.1;margin-bottom:8px;
      }
      #pp-watchdog-box .wd-sub {
        font-family:'Space Mono',monospace;font-size:12px;
        color:rgba(255,255,255,0.6);letter-spacing:1px;margin-bottom:24px;line-height:1.6;
      }
      #pp-watchdog-box .wd-timer {
        font-size:52px;color:#fff;letter-spacing:6px;margin-bottom:24px;
      }
      #pp-watchdog-box .wd-timer span { color:#e53e3e; }
      #pp-watchdog-box .wd-btn-pay {
        display:block;width:100%;padding:18px;background:#e53e3e;
        color:#fff;border:none;cursor:pointer;font-family:inherit;
        font-size:20px;letter-spacing:3px;text-transform:uppercase;
        text-decoration:none;margin-bottom:12px;transition:background .2s;
      }
      #pp-watchdog-box .wd-btn-pay:hover { background:#c53030; }
      #pp-watchdog-box .wd-btn-cancel {
        font-family:'Space Mono',monospace;font-size:10px;
        color:rgba(255,255,255,0.25);background:none;border:none;cursor:pointer;
        letter-spacing:1px;text-transform:uppercase;
      }
      #pp-watchdog-box .wd-btn-cancel:hover { color:#fc8181; }
    `;
    document.head.appendChild(style);

    const modal = document.createElement('div');
    modal.id = 'pp-watchdog-modal';
    modal.innerHTML = `
      <div id="pp-watchdog-box">
        <div class="wd-icon">⚡</div>
        <div class="wd-title">SEU CARRINHO<br>ESTÁ EXPIRANDO</div>
        <div class="wd-sub">
          Produtos reservados por tempo limitado.<br>
          Complete seu pedido agora ou perde tudo.
        </div>
        <div class="wd-timer" id="pp-wd-timer">01:00</div>
        <a href="checkout.html" class="wd-btn-pay" id="pp-wd-pay">
          ⚡ FINALIZAR AGORA
        </a>
        <button class="wd-btn-cancel" id="pp-wd-cancel">Desistir do pedido</button>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('pp-wd-pay').addEventListener('click', function() {
      modal.classList.remove('active');
      clearInterval(window.__ppWdCountdown);
    });

    document.getElementById('pp-wd-cancel').addEventListener('click', function() {
      resetCart();
      modal.classList.remove('active');
      clearInterval(window.__ppWdCountdown);
      // Recarrega página para refletir carrinho vazio
      location.reload();
    });
  }

  function showWarningModal(secondsLeft) {
    const modal = document.getElementById('pp-watchdog-modal');
    if (!modal) return;
    modal.classList.add('active');

    clearInterval(window.__ppWdCountdown);
    let secs = secondsLeft;

    function updateTimer() {
      const el = document.getElementById('pp-wd-timer');
      if (!el) return;
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      el.innerHTML = `<span>${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}</span>`;
    }
    updateTimer();

    window.__ppWdCountdown = setInterval(function() {
      secs--;
      updateTimer();
      if (secs <= 0) {
        clearInterval(window.__ppWdCountdown);
        resetCart();
        modal.classList.remove('active');
        location.reload();
      }
    }, 1000);
  }

  function tick() {
    if (!cartHasItems()) {
      localStorage.removeItem(KEY_TS);
      return;
    }
    if (isPaid()) return;

    const ts = parseInt(localStorage.getItem(KEY_TS) || '0');
    if (!ts) {
      localStorage.setItem(KEY_TS, Date.now().toString());
      return;
    }

    const elapsed = Date.now() - ts;
    const remaining = TIMEOUT_MS - elapsed;

    if (remaining <= 0) {
      // Já expirou
      resetCart();
      if (!document.getElementById('pp-watchdog-modal')?.classList.contains('active')) {
        location.reload();
      }
      return;
    }

    if (remaining <= WARN_MS) {
      injectModal();
      const modal = document.getElementById('pp-watchdog-modal');
      if (modal && !modal.classList.contains('active')) {
        showWarningModal(Math.ceil(remaining / 1000));
      }
    }
  }

  // Inicia ao carregar
  window.addEventListener('DOMContentLoaded', function() {
    startTimer();
    injectModal();
    setInterval(tick, 5000); // checa a cada 5s
    tick(); // primeira checagem imediata
  });

  // Marca como pago ao chegar em confirmacao.html (chamado pelo checkout)
  window.ppMarkPaid = function() {
    localStorage.setItem(KEY_PAID, '1');
    resetCart();
  };

})();
