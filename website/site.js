// Shared by the landing page and the docs: the theme toggle and copy buttons.
// The <head> of every page sets data-theme before paint; this wires up the rest.
(function () {
  var root = document.documentElement;
  var KEY = "ticket-theme";
  var system = window.matchMedia("(prefers-color-scheme: dark)");

  function resolved() {
    return (
      root.getAttribute("data-theme") || (system.matches ? "dark" : "light")
    );
  }
  function sync() {
    var theme = resolved();
    root.setAttribute("data-resolved-theme", theme);
    document.querySelectorAll(".theme-toggle").forEach(function (button) {
      button.setAttribute(
        "aria-label",
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      );
    });
  }

  system.addEventListener("change", sync);
  document.querySelectorAll(".theme-toggle").forEach(function (button) {
    button.addEventListener("click", function () {
      var next = resolved() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
      sync();
    });
  });
  sync();

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  function write(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = document.execCommand("copy");
    area.remove();
    return ok ? Promise.resolve() : Promise.reject();
  }

  // A copy button that copies whatever getText returns when clicked.
  function copyButton(getText, label) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.innerHTML = ICON + "<span>Copy</span>";
    button.setAttribute("aria-label", label || "Copy to clipboard");
    var timer = 0;
    button.addEventListener("click", function () {
      write(getText()).then(
        function () {
          clearTimeout(timer);
          button.classList.add("done");
          button.querySelector("span").textContent = "Copied";
          timer = setTimeout(function () {
            button.classList.remove("done");
            button.querySelector("span").textContent = "Copy";
          }, 1600);
        },
        function () {},
      );
    });
    return button;
  }

  // Shell commands lose their "$ " prompts and "# ..." comment lines.
  function commandText(code) {
    return code.textContent
      .split("\n")
      .filter(function (line) {
        return line.trim() !== "" && !/^\s*#/.test(line);
      })
      .map(function (line) {
        return line.replace(/^\s*\$\s?/, "");
      })
      .join("\n");
  }

  // <span data-copy="text"> or [data-copy] with no value copies its own text.
  document.querySelectorAll("[data-copy]").forEach(function (el) {
    var value = el.getAttribute("data-copy");
    el.appendChild(
      copyButton(function () {
        return value || commandText(el.querySelector("code") || el);
      }),
    );
  });

  window.Ticket = { copyButton: copyButton, commandText: commandText };
})();
