package com.agystudio.remote

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.CookieManager
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

object AppUpdater {
    data class ReleaseInfo(
        val versionCode: Int,
        val versionName: String,
        val bytes: Long,
        val sha256: String,
        val downloadUrl: String
    )

    private val executor = Executors.newSingleThreadExecutor()
    private val inFlight = AtomicBoolean(false)

    fun checkForUpdate(activity: AppCompatActivity, silent: Boolean) {
        if (!inFlight.compareAndSet(false, true)) {
            if (!silent) {
                activity.runOnUiThread {
                    Toast.makeText(activity, "正在检查更新，请稍候…", Toast.LENGTH_SHORT).show()
                }
            }
            return
        }

        executor.execute {
            try {
                val serverUrl = ServerPrefs.getServerUrl(activity).trimEnd('/')
                val latestUrl = "$serverUrl/api/android/latest"
                val cookie = CookieManager.getInstance().getCookie(serverUrl).orEmpty()

                val conn = (URL(latestUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                    connectTimeout = 8000
                    readTimeout = 10000
                    setRequestProperty("Accept", "application/json")
                    if (cookie.isNotBlank()) {
                        setRequestProperty("Cookie", cookie)
                    }
                }

                try {
                    val code = conn.responseCode
                    val contentType = conn.contentType.orEmpty().lowercase()
                    if (code in 300..399 || contentType.contains("text/html")) {
                        if (!silent) {
                            showToast(activity, "登录态已过期，请刷新页面重新登录后再检查更新")
                        }
                        return@execute
                    }
                    if (code != HttpURLConnection.HTTP_OK) {
                        if (!silent) {
                            showToast(activity, "检查更新失败 (HTTP $code)")
                        }
                        return@execute
                    }

                    val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val json = JSONObject(body)
                    if (!json.optBoolean("ok", false)) {
                        if (!silent) {
                            showToast(activity, "检查更新失败：${json.optString("error", "unknown")}")
                        }
                        return@execute
                    }
                    if (!json.optBoolean("available", false)) {
                        if (!silent) {
                            showToast(activity, "当前服务器尚未发布更新包")
                        }
                        return@execute
                    }

                    val versionCode = json.optInt("versionCode", 0)
                    val versionName = json.optString("versionName", "").trim()
                    val bytes = json.optLong("bytes", 0L)
                    val sha256 = json.optString("sha256", "").trim().lowercase()
                    val downloadPath = json.optString("downloadPath", "/api/android/apk").trim()

                    if (versionCode <= 0 || versionName.isEmpty() || sha256.length != 64 || bytes <= 0L) {
                        if (!silent) {
                            showToast(activity, "服务器返回的版本元数据无效")
                        }
                        return@execute
                    }

                    if (versionCode <= BuildConfig.VERSION_CODE) {
                        if (!silent) {
                            showToast(activity, "已是最新版本 (v${BuildConfig.VERSION_NAME})")
                        }
                        return@execute
                    }

                    val downloadUrl = if (downloadPath.startsWith("http://") || downloadPath.startsWith("https://")) {
                        downloadPath
                    } else {
                        val rel = if (downloadPath.startsWith("/")) downloadPath else "/$downloadPath"
                        "$serverUrl$rel"
                    }

                    val info = ReleaseInfo(
                        versionCode = versionCode,
                        versionName = versionName,
                        bytes = bytes,
                        sha256 = sha256,
                        downloadUrl = downloadUrl
                    )

                    activity.runOnUiThread {
                        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                        val mbStr = String.format("%.2f", info.bytes / 1048576.0)
                        MaterialAlertDialogBuilder(activity)
                            .setTitle("发现新版本 v${info.versionName}")
                            .setMessage("当前版本：v${BuildConfig.VERSION_NAME}\n安装包大小：${mbStr} MB\n直接从个人网关安全下载并校验 SHA-256。")
                            .setPositiveButton("立即下载安装") { _, _ ->
                                downloadAndInstall(activity, info)
                            }
                            .setNegativeButton("稍后", null)
                            .show()
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (err: Exception) {
                if (!silent) {
                    showToast(activity, "检查更新异常：${err.message ?: "网络不可用"}")
                }
            } finally {
                inFlight.set(false)
            }
        }
    }

    fun downloadAndInstall(activity: AppCompatActivity, info: ReleaseInfo) {
        if (!inFlight.compareAndSet(false, true)) {
            showToast(activity, "已有更新任务正在进行中")
            return
        }

        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) {
                inFlight.set(false)
                return@runOnUiThread
            }
            val density = activity.resources.displayMetrics.density
            val padH = (20 * density).toInt()
            val padV = (14 * density).toInt()

            val statusText = TextView(activity).apply {
                text = "正在连接网关下载安装包…"
                textSize = 13f
                setPadding(0, 0, 0, (10 * density).toInt())
            }
            val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 100
                progress = 0
                isIndeterminate = false
            }
            val box = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(padH, padV, padH, padV)
                addView(statusText)
                addView(progressBar)
            }

            val dialog: AlertDialog = MaterialAlertDialogBuilder(activity)
                .setTitle("正在下载 AGY Remote v${info.versionName}")
                .setView(box)
                .setCancelable(false)
                .show()

            executor.execute {
                var outFile: File? = null
                try {
                    val updatesDir = File(activity.cacheDir, "updates").apply { mkdirs() }
                    updatesDir.listFiles()?.forEach { runCatching { it.delete() } }
                    val targetFile = File(updatesDir, "AGY-Studio-Remote-update.apk")
                    outFile = targetFile

                    val cookie = CookieManager.getInstance().getCookie(info.downloadUrl)
                        ?: CookieManager.getInstance().getCookie(ServerPrefs.getServerUrl(activity))
                        ?: ""
                    val conn = (URL(info.downloadUrl).openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        instanceFollowRedirects = false
                        connectTimeout = 10000
                        readTimeout = 30000
                        if (cookie.isNotBlank()) {
                            setRequestProperty("Cookie", cookie)
                        }
                    }

                    try {
                        val code = conn.responseCode
                        val contentType = conn.contentType.orEmpty().lowercase()
                        if (code in 300..399 || contentType.contains("text/html")) {
                            throw IllegalStateException("登录态已过期，请刷新页面重新登录后再下载")
                        }
                        if (code != HttpURLConnection.HTTP_OK) {
                            throw IllegalStateException("下载失败 (HTTP $code)")
                        }

                        val totalBytes = conn.contentLengthLong.takeIf { it > 0 } ?: info.bytes
                        val digest = MessageDigest.getInstance("SHA-256")
                        val buf = ByteArray(8192)
                        var downloaded = 0L
                        var lastUiUpdateMs = 0L

                        conn.inputStream.use { input ->
                            FileOutputStream(targetFile).use { output ->
                                while (true) {
                                    val read = input.read(buf)
                                    if (read <= 0) break
                                    output.write(buf, 0, read)
                                    digest.update(buf, 0, read)
                                    downloaded += read

                                    val nowMs = System.currentTimeMillis()
                                    if (nowMs - lastUiUpdateMs >= 80L || downloaded >= totalBytes) {
                                        lastUiUpdateMs = nowMs
                                        val pct = if (totalBytes > 0) ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 100) else 0
                                        val dlMb = String.format("%.2f", downloaded / 1048576.0)
                                        val totMb = String.format("%.2f", totalBytes / 1048576.0)
                                        activity.runOnUiThread {
                                            if (dialog.isShowing) {
                                                progressBar.progress = pct
                                                statusText.text = "已下载 $dlMb / $totMb MB ($pct%)"
                                            }
                                        }
                                    }
                                }
                                output.fd.sync()
                            }
                        }

                        val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                        if (!actualSha.equals(info.sha256, ignoreCase = true) || targetFile.length() <= 0L) {
                            runCatching { targetFile.delete() }
                            throw IllegalStateException("安装包校验失败，请重试")
                        }

                        activity.runOnUiThread {
                            runCatching { if (dialog.isShowing) dialog.dismiss() }
                            if (!activity.isFinishing && !activity.isDestroyed) {
                                installApk(activity, targetFile)
                            }
                        }
                    } finally {
                        conn.disconnect()
                    }
                } catch (err: Exception) {
                    runCatching { outFile?.delete() }
                    activity.runOnUiThread {
                        runCatching { if (dialog.isShowing) dialog.dismiss() }
                        showToast(activity, err.message ?: "安装包校验失败，请重试")
                    }
                } finally {
                    inFlight.set(false)
                }
            }
        }
    }

    private fun installApk(activity: AppCompatActivity, apkFile: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(activity, "请允许 AGY Remote 安装应用更新，授权后返回重新点击安装", Toast.LENGTH_LONG).show()
            try {
                val permIntent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}")
                )
                activity.startActivity(permIntent)
            } catch (_: Exception) {
            }
            return
        }

        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apkFile)
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(installIntent)
        } catch (err: Exception) {
            Toast.makeText(activity, "无法拉起系统安装器：${err.message ?: "unknown"}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showToast(activity: AppCompatActivity, msg: String) {
        activity.runOnUiThread {
            if (!activity.isFinishing && !activity.isDestroyed) {
                Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
