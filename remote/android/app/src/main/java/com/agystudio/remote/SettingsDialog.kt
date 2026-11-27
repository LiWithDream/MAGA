package com.agystudio.remote

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch

object SettingsDialog {
    fun show(
        context: Context,
        onServerUrlUpdated: (String) -> Unit,
        onForceReload: (Boolean) -> Unit,
        onKeepAliveToggled: (Boolean) -> Unit,
        onCheckForUpdate: () -> Unit
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

        val currentUrl = ServerPrefs.getServerUrl(context)
        val urlInput = EditText(context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(currentUrl)
            setSelection(text.length)
            hint = BuildConfig.DEFAULT_SERVER_URL
            isSingleLine = true
        }

        val keepAliveSwitch = MaterialSwitch(context).apply {
            text = "后台常驻监听推送（通知栏显示保活状态，锁屏/切后台也能收审批提醒）"
            textSize = 13f
            isChecked = ServerPrefs.isKeepAliveEnabled(context)
            setPadding(0, (12 * density).toInt(), 0, (6 * density).toInt())
        }

        var dialogRef: AlertDialog? = null

        val checkUpdateBtn = Button(context, null, android.R.attr.borderlessButtonStyle).apply {
            text = "检查 App 更新 (v${BuildConfig.VERSION_NAME})"
            textSize = 13f
            isAllCaps = false
            setOnClickListener {
                dialogRef?.dismiss()
                onCheckForUpdate()
            }
        }

        val batteryOptBtn = Button(context, null, android.R.attr.borderlessButtonStyle).apply {
            text = "电池优化设置（防系统杀后台）"
            textSize = 13f
            isAllCaps = false
            setOnClickListener {
                try {
                    context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                } catch (_: Exception) {
                    try {
                        val fallback = Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:${context.packageName}")
                        )
                        context.startActivity(fallback)
                    } catch (_: Exception) {
                        Toast.makeText(context, "请在系统设置 → 电池中将 AGY Remote 设为不受限制", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }

        val metaLabel = TextView(context).apply {
            text = "版本 v${BuildConfig.VERSION_NAME} · 三指轻触页面也可随时唤起此面板"
            textSize = 11.5f
            alpha = 0.65f
            setPadding(0, (8 * density).toInt(), 0, 0)
        }

        container.addView(hintLabel)
        container.addView(urlInput)
        container.addView(keepAliveSwitch)
        container.addView(checkUpdateBtn)
        container.addView(batteryOptBtn)
        container.addView(metaLabel)

        dialogRef = MaterialAlertDialogBuilder(context)
            .setTitle("AGY Remote 原生设置")
            .setView(container)
            .setPositiveButton("保存并应用") { _, _ ->
                val saved = ServerPrefs.setServerUrl(context, urlInput.text.toString())
                if (saved == null) {
                    Toast.makeText(context, "服务器地址格式无效，请以 https:// 或 http:// 开头", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                onKeepAliveToggled(keepAliveSwitch.isChecked)
                if (saved != currentUrl) {
                    onServerUrlUpdated(saved)
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
