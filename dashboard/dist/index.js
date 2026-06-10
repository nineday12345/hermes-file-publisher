(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const React = SDK.React;
  const hooks = SDK.hooks;

  const API_BASE = "/api/plugins/file-publisher";

  function h(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return React.createElement(type, props || null, ...children);
  }

  function errorToMessage(err) {
    let message = "";
    if (!err) message = "未知错误";
    else if (typeof err === "string") message = err;
    else if (err.detail) message = String(err.detail);
    else if (err.message) message = String(err.message);
    else if (err.status || err.statusText) {
      message = ["请求失败", err.status, err.statusText].filter(Boolean).join(" ");
    }
    if (message.includes("No such API endpoint") && message.includes("/api/plugins/file-publisher")) {
      return "插件后端 API 未挂载。请重启 Hermes dashboard/容器；只扫描 manifest 不会加载 plugin_api.py。";
    }
    if (message) return message;
    if (err.status || err.statusText) {
      return ["请求失败", err.status, err.statusText].filter(Boolean).join(" ");
    }
    try {
      return JSON.stringify(err);
    } catch (_jsonErr) {
      return String(err) || "未知错误";
    }
  }

  async function requestJSON(path, options) {
    const authedPath = API_BASE + path;
    if (typeof SDK.fetchJSON === "function") {
      return SDK.fetchJSON(authedPath, options);
    }

    const headers = new Headers((options && options.headers) || {});
    if (options && options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(authedPath, {
      ...options,
      headers,
      credentials: "same-origin",
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const payload = await response.json();
        message = payload.detail || payload.message || message;
      } catch (_err) {
        /* keep statusText */
      }
      throw new Error(message);
    }
    return response.json();
  }

  async function requestFile(path, options) {
    const url = API_BASE + path;
    const headers = new Headers((options && options.headers) || {});

    const fetcher = typeof SDK.authedFetch === "function" ? SDK.authedFetch : fetch;
    return fetcher(url, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  }

  function buildApiPath(path, query) {
    const params = new URLSearchParams();
    Object.keys(query || {}).forEach((key) => {
      const value = query[key];
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, value);
      }
    });
    const qs = params.toString();
    return path + (qs ? "?" + qs : "");
  }

  function joinUrl(path, query) {
    return API_BASE + buildApiPath(path, query);
  }

  function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return "-";
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value = value / 1024;
      unitIndex += 1;
    }
    return value.toFixed(value >= 10 ? 1 : 2) + " " + units[unitIndex];
  }

  function formatTime(value) {
    if (!value) return "-";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value));
    } catch (_err) {
      return value;
    }
  }

  function typeLabel(type) {
    if (type === "directory") return "目录";
    if (type === "file") return "文件";
    if (type === "symlink") return "链接";
    return "其他";
  }

  function pathSegments(path) {
    if (!path) return [];
    return path.split("/").filter(Boolean);
  }

  function breadcrumbTargets(path) {
    const segments = pathSegments(path);
    let current = "";
    return segments.map((segment) => {
      current = current ? current + "/" + segment : segment;
      return { label: segment, path: current };
    });
  }

  function FileManager() {
    const useState = hooks.useState;
    const useEffect = hooks.useEffect;
    const useCallback = hooks.useCallback;
    const [config, setConfig] = useState(null);
    const [currentPath, setCurrentPath] = useState("");
    const [items, setItems] = useState([]);
    const [parent, setParent] = useState("");
    const [query, setQuery] = useState("");
    const [includeHidden, setIncludeHidden] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    const loadConfig = useCallback(async () => {
      try {
        const data = await requestJSON("/config");
        setConfig(data);
        setError("");
      } catch (err) {
        setError(errorToMessage(err));
      }
    }, []);

    const loadFiles = useCallback(
      async (nextPath, nextQuery, nextIncludeHidden) => {
        setLoading(true);
        setError("");
        try {
          const data = await requestJSON(
            buildApiPath("/files", {
              path: nextPath,
              q: nextQuery,
              include_hidden: nextIncludeHidden ? "true" : "false",
            })
          );
          setCurrentPath(data.path || "");
          setParent(data.parent || "");
          setItems(data.items || []);
          if (data.truncated) {
            setNotice("当前目录文件较多，已按上限显示。");
          } else {
            setNotice("");
          }
        } catch (err) {
          setError(errorToMessage(err));
          setItems([]);
        } finally {
          setLoading(false);
        }
      },
      []
    );

    useEffect(() => {
      loadConfig();
      loadFiles("", "", false);
    }, [loadConfig, loadFiles]);

    useEffect(() => {
      const timer = window.setTimeout(() => {
        loadFiles(currentPath, query, includeHidden);
      }, 250);
      return () => window.clearTimeout(timer);
    }, [query, includeHidden]);

    async function downloadFile(item) {
      setError("");
      try {
        const headers = new Headers();
        const response = await requestFile(buildApiPath("/download", { path: item.path }), { headers });
        if (!response.ok) {
          let message = response.statusText;
          try {
            const payload = await response.json();
            message = payload.detail || payload.message || message;
          } catch (_err) {
            /* keep statusText */
          }
          throw new Error(message);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = item.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        setError(errorToMessage(err));
      }
    }

    async function copyLink(item) {
      const url = new URL(joinUrl("/download", { path: item.path }), window.location.origin);
      try {
        await navigator.clipboard.writeText(url.toString());
        setNotice("下载链接已复制。");
      } catch (_err) {
        setError(url.toString());
      }
    }

    async function deleteItem(item) {
      const ok = window.confirm("确认删除：" + item.name + "？");
      if (!ok) return;
      setError("");
      try {
        await requestJSON("/files", {
          method: "DELETE",
          body: JSON.stringify({ path: item.path, confirm: true }),
        });
        setNotice("已删除：" + item.name);
        loadFiles(currentPath, query, includeHidden);
      } catch (err) {
        setError(errorToMessage(err));
      }
    }

    const breadcrumbs = breadcrumbTargets(currentPath);
    const configWarning =
      config && !config.exists ? "当前根目录不存在：" + config.root : "";

    return h(
      "div",
      { className: "fp-page" },
      h(
        "div",
        { className: "fp-toolbar" },
        h(
          "div",
          { className: "fp-title-block" },
          h("h1", null, "文件管理"),
          h("div", { className: "fp-root", title: config && config.root }, config ? config.root : "读取中")
        ),
        h(
          "div",
          { className: "fp-actions" },
          h("button", { className: "fp-button", onClick: () => loadFiles(currentPath, query, includeHidden) }, "刷新")
        )
      ),
      h(
        "div",
        { className: "fp-filters" },
        h("input", {
          className: "fp-input fp-search",
          value: query,
          placeholder: "搜索文件名",
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          "label",
          { className: "fp-check" },
          h("input", {
            type: "checkbox",
            checked: includeHidden,
            onChange: (event) => setIncludeHidden(event.target.checked),
          }),
          "显示隐藏文件"
        )
      ),
      h(
        "div",
        { className: "fp-breadcrumbs" },
        h("button", { className: "fp-link", onClick: () => loadFiles("", query, includeHidden) }, "data"),
        breadcrumbs.map((segment) =>
          h(
            React.Fragment,
            { key: segment.path },
            h("span", { className: "fp-separator" }, "/"),
            h(
              "button",
              { className: "fp-link", onClick: () => loadFiles(segment.path, query, includeHidden) },
              segment.label
            )
          )
        )
      ),
      (error || notice || configWarning) &&
        h(
          "div",
          { className: error || configWarning ? "fp-message fp-error" : "fp-message" },
          error || configWarning || notice
        ),
      h(
        "div",
        { className: "fp-table-wrap" },
        h(
          "table",
          { className: "fp-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, "名称"),
              h("th", null, "类型"),
              h("th", null, "大小"),
              h("th", null, "修改时间"),
              h("th", null, "")
            )
          ),
          h(
            "tbody",
            null,
            currentPath &&
              h(
                "tr",
                { className: "fp-row" },
                h(
                  "td",
                  null,
                  h("button", { className: "fp-name", onClick: () => loadFiles(parent, query, includeHidden) }, "..")
                ),
                h("td", null, "上级"),
                h("td", null, "-"),
                h("td", null, "-"),
                h("td", null, "")
              ),
            loading &&
              h(
                "tr",
                null,
                h("td", { colSpan: 5, className: "fp-empty" }, "加载中")
              ),
            !loading && items.length === 0 &&
              h(
                "tr",
                null,
                h("td", { colSpan: 5, className: "fp-empty" }, "没有文件")
              ),
            !loading &&
              items.map((item) =>
                h(
                  "tr",
                  { className: "fp-row", key: item.path },
                  h(
                    "td",
                    null,
                    item.type === "directory"
                      ? h(
                          "button",
                          { className: "fp-name fp-folder", onClick: () => loadFiles(item.path, query, includeHidden) },
                          item.name
                        )
                      : h("span", { className: "fp-name-static" }, item.name)
                  ),
                  h("td", null, h("span", { className: "fp-pill" }, typeLabel(item.type))),
                  h("td", null, formatSize(item.size)),
                  h("td", null, formatTime(item.modified_at)),
                  h(
                    "td",
                    { className: "fp-row-actions" },
                    item.downloadable &&
                      h("button", { className: "fp-icon-button", title: "下载", onClick: () => downloadFile(item) }, "下载"),
                    item.downloadable &&
                      h("button", { className: "fp-icon-button", title: "复制链接", onClick: () => copyLink(item) }, "链接"),
                    item.deletable &&
                      h("button", { className: "fp-icon-button fp-danger", title: "删除", onClick: () => deleteItem(item) }, "删除")
                  )
                )
              )
          )
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("file-publisher", FileManager);
})();
