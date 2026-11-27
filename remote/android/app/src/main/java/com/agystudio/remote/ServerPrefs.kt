package com.agystudio.remote

import android.content.Context
import android.net.Uri

object ServerPrefs {
    private const val PREF_NAME = "agy_remote_native"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_KEEPALIVE_ENABLED = "keepalive_enabled"

    fun isKeepAliveEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_KEEPALIVE_ENABLED, false)
    }

    fun setKeepAliveEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_KEEPALIVE_ENABLED, enabled).apply()
    }

    fun getServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val stored = prefs.getString(KEY_SERVER_URL, null)?.trim()
        return if (!stored.isNullOrEmpty() && isValidServerUrl(stored)) {
            stored
        } else {
            BuildConfig.DEFAULT_SERVER_URL
        }
    }

    fun setServerUrl(context: Context, rawUrl: String): String? {
        val normalized = normalizeServerUrl(rawUrl) ?: return null
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
        return normalized
    }

    fun resetServerUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        prefs.edit().remove(KEY_SERVER_URL).apply()
        return BuildConfig.DEFAULT_SERVER_URL
    }

    fun normalizeServerUrl(rawUrl: String): String? {
        val trimmed = rawUrl.trim().removeSuffix("/")
        if (trimmed.isEmpty()) return null
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
        return if (isValidServerUrl(withScheme)) withScheme else null
    }

    fun isValidServerUrl(url: String): Boolean {
        return try {
            val uri = Uri.parse(url)
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.trim()
            (scheme == "https" || scheme == "http") && !host.isNullOrEmpty()
        } catch (_: Exception) {
            false
        }
    }
}
