// Loaded blocking in <head> so the saved theme applies before first paint.
// The toggle itself lives in site.js.
(function (r) {
  try {
    var t = localStorage.getItem("ticket-theme");
    if (t) r.setAttribute("data-theme", t);
  } catch (e) {}
  r.setAttribute(
    "data-resolved-theme",
    r.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
})(document.documentElement);
