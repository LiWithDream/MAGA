package com.agystudio.remote

import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.dialog.MaterialAlertDialogBuilder

object SettingsDialog {
    fun show(
        context: Context,
        onServerUrlUpdated: (String) -> Unit,
        onForceReload: (Boolean) -> Unit
    ) {
        val density = context.resources.displayMetrics.density
        val padH = (20 * density).toInt()
        val padV = (10 * density).toInt()

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padH, padV, padH, padV)
        }

        val hintLabel = TextView(context).apply {
            text = "远程控制地址（默认 ${BuildConfig.DEFAULT_SERVER_URL}）"
            textSize = 13f
            setPadding(0, 0, 0, (8 * density).toInt())
        }

        val urlInput = EditText(context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(ServerPrefs.getServerUrl(context))
            setSelection(text.length)
            hint = BuildConfig.DEFAULT_SERVER_URL
            isSingleLine = true
        }

        val metaLabel = TextView(context).apply {
            text = "版本 v${BuildConfig.VERSION_NAME} · 三指轻触页面也可随时唤起此面板"
            textSize = 11.5f
            alpha = 0.65f
            setPadding(0, (10 * density).toInt(), 0, 0)
        }

        container.addView(hintLabel)
        container.addView(urlInput)
        container.addView(metaLabel)

        MaterialAlertDialogBuilder(context)
            .setTitle("AGY Remote 原生设置")
            .setView(container)
            .setPositiveButton("保存并加载") { _, _ ->
                val saved = ServerPrefs.setServerUrl(context, urlInput.text.toString())
                if (saved != null) {
                    onServerUrlUpdated(saved)
                } else {
                    Toast.makeText(context, "服务器地址格式无效，请以 https:// 或 http:// 开头", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("清理缓存并刷新") { _, _ ->
                onForceReload(true)
            }
            .setNegativeButton("系统通知设置") { _, _ ->
                try {
                    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                    }
                    context.startActivity(intent)
                } catch (_: Exception) {
                    Toast.makeText(context, "请在系统设置中管理应用通知权限", Toast.LENGTH_SHORT).show()
                }
            }
            .show()
    }
}
