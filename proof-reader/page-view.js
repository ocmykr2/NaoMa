(() => {
  "use strict";

  const views = new WeakMap();

  function releaseImage(view) {
    if (view.img) {
      view.img.onload = null;
      view.img.onerror = null;
      view.img.removeAttribute("src");
      view.img = null;
    }
    if (view.objectUrl) {
      URL.revokeObjectURL(view.objectUrl);
      view.objectUrl = null;
    }
  }

  function clear(host) {
    const view = views.get(host);
    if (view) {
      views.delete(host);
      releaseImage(view);
      view.finish(false);
    }
    host.replaceChildren();
    host.removeAttribute("aria-busy");
  }

  function localImagePath(path, doc) {
    if (typeof path !== "string" || !path.trim()) throw new Error("Missing page image.");
    const directory = new URL(".", doc.baseURI);
    const url = new URL(path, directory);
    if (!["http:", "https:", "file:"].includes(url.protocol) || !url.href.startsWith(directory.href)) {
      throw new Error("Invalid local page image.");
    }
    return url.href;
  }

  function show(host, { image, file, page }) {
    const previous = views.get(host);
    if (previous && previous.page === page && previous.file === file && previous.image === image && !previous.failed) {
      return previous.ready;
    }
    clear(host);
    const doc = host.ownerDocument;
    const view = { image, file, page, failed: false };
    view.ready = new Promise((resolve) => { view.finish = resolve; });
    views.set(host, view);
    const isCurrent = () => views.get(host) === view;

    host.classList.add("page-frame");
    host.setAttribute("aria-busy", "true");
    const message = doc.createElement("p");
    message.className = "page-message";
    message.setAttribute("role", "status");
    message.textContent = "Loading the original page…";
    host.append(message);

    function fail() {
      if (!isCurrent()) return;
      view.failed = true;
      releaseImage(view);
      host.removeAttribute("aria-busy");
      message.textContent = "This page preview could not be loaded.";
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.className = "control";
      retry.textContent = "Retry preview";
      retry.addEventListener("click", () => show(host, { image, file, page }));
      host.replaceChildren(message, retry);
      view.finish(false);
    }

    async function load() {
      try {
        if (!Number.isInteger(page) || page < 1) throw new Error("Invalid page number.");
        let url;
        if (file) {
          const blob = await window.PDF_READER.renderPage(file, page);
          if (!isCurrent()) return;
          view.objectUrl = URL.createObjectURL(blob);
          url = view.objectUrl;
        } else {
          url = localImagePath(image, doc);
        }
        const img = doc.createElement("img");
        view.img = img;
        img.alt = "Page " + page + " of the original paper.";
        img.className = "original-page-image";
        img.onerror = fail;
        img.onload = () => {
          if (!isCurrent()) return;
          host.removeAttribute("aria-busy");
          const controls = doc.createElement("div");
          controls.className = "page-controls";
          const label = doc.createElement("span");
          label.textContent = "Original page " + page;
          const zoom = doc.createElement("button");
          zoom.type = "button";
          zoom.className = "control";
          zoom.textContent = "Enlarge page";
          zoom.setAttribute("aria-pressed", "false");
          const viewport = doc.createElement("div");
          viewport.className = "page-viewport";
          viewport.tabIndex = 0;
          viewport.setAttribute("role", "region");
          viewport.setAttribute("aria-label", "Scroll original page " + page);
          zoom.addEventListener("click", () => {
            const enlarged = viewport.classList.toggle("is-enlarged");
            zoom.setAttribute("aria-pressed", String(enlarged));
            zoom.textContent = enlarged ? "Fit to width" : "Enlarge page";
            if (!enlarged) viewport.scrollLeft = 0;
          });
          controls.append(label, zoom);
          viewport.append(img);
          host.replaceChildren(controls, viewport);
          view.finish(true);
        };
        img.src = url;
      } catch {
        fail();
      }
    }

    load();
    return view.ready;
  }

  window.pageView = { show, clear };
})();
