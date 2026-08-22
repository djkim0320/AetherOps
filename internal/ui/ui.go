// Package ui serves the locally embedded AetherOps single-page application.
package ui

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// assets is populated by `npm run build` in frontend. Keeping it embedded means
// the desktop executable does not need a separate web server or asset directory.
//
//go:embed assets
var assets embed.FS

type spaHandler struct {
	files fs.FS
	index []byte
}

// NewHandler returns a handler for the embedded single-page application. It
// intentionally does not handle /api/ paths, so an application's API mux is
// always responsible for those routes.
func NewHandler() http.Handler {
	files, err := fs.Sub(assets, "assets")
	if err != nil {
		panic("aetherops ui assets are unavailable: " + err.Error())
	}
	index, err := fs.ReadFile(files, "index.html")
	if err != nil {
		panic("aetherops ui index is unavailable: " + err.Error())
	}
	return &spaHandler{files: files, index: index}
}

func (handler *spaHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestPath := path.Clean("/" + request.URL.Path)
	if requestPath == "/api" || strings.HasPrefix(requestPath, "/api/") {
		http.NotFound(writer, request)
		return
	}

	assetName := strings.TrimPrefix(requestPath, "/")
	if assetName != "" && assetName != "index.html" && !strings.HasSuffix(request.URL.Path, "/") {
		if contents, err := fs.ReadFile(handler.files, assetName); err == nil {
			if contentType := mime.TypeByExtension(path.Ext(assetName)); contentType != "" {
				writer.Header().Set("Content-Type", contentType)
			}
			writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			writer.WriteHeader(http.StatusOK)
			if request.Method != http.MethodHead {
				_, _ = writer.Write(contents)
			}
			return
		}
	}

	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = writer.Write(handler.index)
	}
}
