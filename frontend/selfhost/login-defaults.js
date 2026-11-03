(() => {
  const selector = "form.main_ui_auth_login__form";
  const handled = new WeakSet();
  const edited = new WeakSet();
  let defaults = null;
  let loading;
  let applying = false;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;

  function loadDefaults() {
    if (loading) return;
    loading = fetch("/js/selfhost-login.json", {
      cache: "no-store",
      credentials: "omit",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (
          typeof value?.email === "string" &&
          value.email &&
          typeof value?.password === "string" &&
          value.password
        ) {
          defaults = value;
          fill();
        }
      })
      .catch(() => {});
  }

  function fill() {
    const forms = document.querySelectorAll(selector);
    if (!forms.length) return;
    if (!defaults) {
      loadDefaults();
      return;
    }
    for (const form of forms) {
      const email = form.querySelector('input[name="email"]');
      const password = form.querySelector('input[name="password"]');
      if (
        !email ||
        edited.has(email) ||
        (email.value && email.value !== defaults.email)
      )
        continue;
      applying = true;
      try {
        for (const [input, value] of [
          [email, defaults.email],
          [password, defaults.password],
        ]) {
          if (!input || handled.has(input) || edited.has(input)) continue;
          handled.add(input);
          if (input.value) continue;
          // Keep controlled React form state in sync without submitting the form.
          setValue.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } finally {
        applying = false;
      }
    }
  }

  document.addEventListener(
    "input",
    (event) => {
      if (
        !applying &&
        event.target instanceof HTMLInputElement &&
        event.target.form?.matches(selector)
      )
        edited.add(event.target);
    },
    true,
  );
  function start() {
    // SPA replaceState redirects and login modals do not always emit hashchange.
    new MutationObserver(fill).observe(document.body, {
      childList: true,
      subtree: true,
    });
    fill();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else start();
})();
