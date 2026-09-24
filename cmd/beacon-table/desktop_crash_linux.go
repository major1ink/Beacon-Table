//go:build desktop && linux && gtk3

package main

/*
#cgo linux pkg-config: gtk+-3.0 webkit2gtk-4.1
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

static gboolean reload_later(gpointer view) {
	webkit_web_view_reload(WEBKIT_WEB_VIEW(view));
	g_object_unref(view);
	return G_SOURCE_REMOVE;
}

// Пауза перед перезагрузкой — драйверу дать отпустить старый контекст.
static void on_terminated(WebKitWebView *view, WebKitWebProcessTerminationReason reason, gpointer data) {
	g_warning("Beacon Table: процесс страницы упал (причина %d), перезагружаю страницу", reason);
	g_timeout_add(300, reload_later, g_object_ref(view));
}

static WebKitWebView *find_webview(GtkWidget *w) {
	if (WEBKIT_IS_WEB_VIEW(w)) return WEBKIT_WEB_VIEW(w);
	if (!GTK_IS_CONTAINER(w)) return NULL;
	GList *children = gtk_container_get_children(GTK_CONTAINER(w));
	WebKitWebView *found = NULL;
	for (GList *l = children; l != NULL && found == NULL; l = l->next) {
		found = find_webview(GTK_WIDGET(l->data));
	}
	g_list_free(children);
	return found;
}

static int watch_web_process(void *window) {
	WebKitWebView *view = find_webview(GTK_WIDGET(window));
	if (view == NULL) return 0;
	g_signal_connect(view, "web-process-terminated", G_CALLBACK(on_terminated), NULL);
	return 1;
}
*/
import "C"

import (
	"log/slog"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// reloadOnCrash — поднять страницу заново, если её процесс упал. На NVIDIA
// под Wayland он время от времени падает внутри EGL-драйвера (переезд окна
// между мониторами), и без этого окно так и оставалось мёртвым, хотя стол
// на сервере жив. Wails этот сигнал WebKit не обрабатывает.
func reloadOnCrash(w *application.WebviewWindow) {
	application.InvokeSync(func() {
		p := w.NativeWindow()
		if p == nil || C.watch_web_process(p) == 0 {
			slog.Warn("Не нашёл WebKit в окне — упавшую страницу перезагрузить не получится", "window", w.Name())
		}
	})
}
