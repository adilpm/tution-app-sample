// Small progressive enhancements; every page works without this file.
(function () {
  // Prevent double submits (e.g. double-tap on "Save payment").
  document.addEventListener('submit', function (e) {
    var form = e.target;
    // Signing out: forget the PostHog identity on this device.
    if (form.getAttribute('action') === '/logout' && window.posthog && window.posthog.reset) window.posthog.reset();
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
      e.preventDefault();
      return;
    }
    if (form.dataset.submitting) {
      e.preventDefault();
      return;
    }
    form.dataset.submitting = '1';
    form.querySelectorAll('button[type=submit], button:not([type])').forEach(function (b) {
      b.disabled = true;
    });
  });

  // Quick amount buttons on the collect form.
  document.querySelectorAll('[data-amount]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById('amount');
      input.value = btn.dataset.amount;
      input.focus();
    });
  });

  // Client-side filter for the "Collect fee" student search.
  var search = document.getElementById('student-search');
  if (search) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-search]'));
    var empty = document.getElementById('no-match');
    var filter = function () {
      var q = search.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (r) {
        var hit = !q || r.dataset.search.indexOf(q) !== -1;
        r.hidden = !hit;
        if (hit) shown++;
      });
      if (empty) empty.hidden = shown !== 0;
    };
    search.addEventListener('input', filter);
    filter();
  }

  // Live present/absent count on the attendance screen.
  var markForm = document.getElementById('mark-form');
  if (markForm) {
    var boxes = markForm.querySelectorAll('input[name=absent]');
    var out = document.getElementById('mark-summary');
    var update = function () {
      var absent = 0;
      boxes.forEach(function (b) { if (b.checked) absent++; });
      out.textContent = (boxes.length - absent) + ' present · ' + absent + ' absent';
    };
    boxes.forEach(function (b) { b.addEventListener('change', update); });
    update();
  }

  // File inputs that post their file as a base64 data URL in a hidden field
  // (logo upload, student import).
  document.querySelectorAll('[data-file-form]').forEach(function (form) {
    var source = form.querySelector('[data-file-source]');
    var target = form.querySelector('[data-file-target]');
    var nameField = form.querySelector('[data-file-name]');
    source.addEventListener('change', function () {
      target.value = '';
      var file = source.files[0];
      if (!file) return;
      var max = Number(source.dataset.maxBytes || 0);
      if (max && file.size > max) {
        source.setCustomValidity('That file is too large (max ' + Math.round(max / 1048576) + ' MB).');
        source.reportValidity();
        return;
      }
      source.setCustomValidity('');
      if (nameField) nameField.value = file.name;
      var reader = new FileReader();
      reader.onload = function () { target.value = reader.result; };
      reader.readAsDataURL(file);
    });
    form.addEventListener('submit', function (e) {
      if (!target.value) {
        e.preventDefault();
        e.stopImmediatePropagation();
        delete form.dataset.submitting;
      }
    }, true);
  });

  // Remember which WhatsApp reminders were already opened (per list, per day,
  // on this device) so nobody gets messaged twice.
  document.querySelectorAll('[data-reminders]').forEach(function (list) {
    var key = 'reminded:' + list.dataset.reminders;
    var sent = [];
    try { sent = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { sent = []; }
    var counter = document.getElementById('sent-count');
    var mark = function (btn) {
      btn.classList.add('sent');
      var label = btn.querySelector('span');
      if (label) label.textContent = 'Sent';
    };
    var refresh = function () { if (counter) counter.textContent = sent.length; };
    list.querySelectorAll('[data-remind]').forEach(function (btn) {
      if (sent.indexOf(btn.dataset.remind) !== -1) mark(btn);
      btn.addEventListener('click', function () {
        if (window.posthog && window.posthog.capture) {
          window.posthog.capture('whatsapp_message_opened', {
            kind: list.dataset.reminders.indexOf('absent-') === 0 ? 'absence' : 'fee_reminder',
            repeat: sent.indexOf(btn.dataset.remind) !== -1,
          });
        }
        if (sent.indexOf(btn.dataset.remind) === -1) sent.push(btn.dataset.remind);
        try { localStorage.setItem(key, JSON.stringify(sent)); } catch (e) { /* private mode */ }
        mark(btn);
        refresh();
      });
    });
    refresh();
  });

  // Share the receipt PDF itself (e.g. to WhatsApp) where the browser supports
  // sharing files; otherwise fall back to a normal download.
  document.querySelectorAll('[data-share-pdf]').forEach(function (btn) {
    if (!navigator.canShare) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var url = btn.dataset.sharePdf;
      var name = btn.dataset.filename || 'receipt.pdf';
      btn.disabled = true;
      fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var file = new File([blob], name, { type: 'application/pdf' });
          if (navigator.canShare({ files: [file] })) {
            return navigator.share({ files: [file], title: name });
          }
          window.location.href = url + '?download=1';
        })
        .catch(function () { /* share sheet dismissed */ })
        .then(function () { btn.disabled = false; });
    });
  });
})();
