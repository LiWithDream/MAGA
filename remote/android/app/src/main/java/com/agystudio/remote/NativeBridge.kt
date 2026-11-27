package com.agystudio.remote

import android.webkit.JavascriptInterface
import org.json.JSONArray

class NativeBridge(
    private val host: HostActions
) {
    interface HostActions {
        fun onOpenSettings()
        fun onNotify(title: String, body: String, tag: String, category: String, cascadeId: String)
        fun onVibrate(timings: LongArray)
        fun onRequestNotificationPermission()
        fun onReloadPage(clearCache: Boolean)
        fun onWebReady()
        fun getCurrentServerUrl(): String
    }

    @JavascriptInterface
    fun isNative(): Boolean = true

    @JavascriptInterface
    fun onWebReady() {
        host.onWebReady()
    }

    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getServerUrl(): String = host.getCurrentServerUrl()

    @JavascriptInterface
    fun openNativeSettings() {
        host.onOpenSettings()
    }

    @JavascriptInterface
    fun notify(title: String?, body: String?, tag: String?, category: String?, cascadeId: String?) {
        host.onNotify(
            title.orEmpty(),
            body.orEmpty(),
            tag.orEmpty(),
            category.orEmpty(),
            cascadeId.orEmpty()
        )
    }

    @JavascriptInterface
    fun vibrate(patternJson: String?) {
        if (patternJson.isNullOrBlank()) return
        try {
            val arr = JSONArray(patternJson)
            val count = arr.length().coerceAtMost(8)
            val timings = LongArray(count) { idx -> arr.optLong(idx, 35L) }
            host.onVibrate(timings)
        } catch (_: Exception) {
        }
    }

    @JavascriptInterface
    fun requestNotificationPermission() {
        host.onRequestNotificationPermission()
    }

    @JavascriptInterface
    fun reloadPage(clearCache: Boolean) {
        host.onReloadPage(clearCache)
    }
}
