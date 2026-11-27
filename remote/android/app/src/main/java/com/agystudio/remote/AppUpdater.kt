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
import java.io.FileInputStream
import java.io.FileOutputStream
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

object AppUpdater {
    private const val MAX_APK_BYTES = 150L * 1024L * 1024L

    data class ReleaseInfo(
        val versionCode: Int,
        val versionName: String,
        val bytes: Long,
        val sha256: String,
        val downloadUrl: String
    )

    private val executor = Executors.newSingleThreadExecutor()
    private val inFlight = AtomicBoolean(false)
    private val downloadCancelled = AtomicBoolean(false)
    @Volatile
    private var activeConn: HttpURLConnection? = null
    @Volatile
    private var activeDialog: AlertDialog? = null
    @Volatile
    private var activeActivityRef: WeakReference<AppCompatActivity>? = null
    @Volatile
    private var pendingInstallFile: File? = null
    @Volatile
    private var pendingInstallSha256: String? = null

    private fun isSafeRelativeDownloadPath(rawPath: String): Boolean {
        return rawPath.startsWith("/") &&
            !rawPath.startsWith("//") &&
            !rawPath.contains("://") &&
            !rawPath.contains("\\")
    }

    private fun isSameOrigin(urlA: String, urlB: String): Boolean {
        return try {
            val a = URL(urlA)
            val b = URL(urlB)
            val portA = if (a.port > 0) a.port else a.defaultPort
            val portB = if (b.port > 0) b.port else b.defaultPort
            a.protocol.equals(b.protocol, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                portA == portB
        } catch (_: Exception) {
            false
        }
    }

    fun checkForUpdate(activity: AppCompatActivity, silent: Boolean) {
        if (!inFlight.compareAndSet(false, true)) {
            if (!silent) {
                activity.runOnUiThread {
                    if (!activity.isFinishing && !activity.isDestroyed) {
                        Toast.makeText(activity, "正在检查更新，请稍候…", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            return
        }

        val appContext = activity.applicationContext
        val activityRef = WeakReference(activity)
        executor.execute {
            try {
                val serverUrl = ServerPrefs.getServerUrl(appContext).trimEnd('/')
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
                    val contentType = conn.contentType.orEmpty().lowercase(Locale.US)
                    if (code in 300..399 || contentType.contains("text/html")) {
                        if (!silent) {
                            showToast(activityRef, "登录态已过期，请刷新页面重新登录后再检查更新")
                        }
                        return@execute
                    }
                    if (code != HttpURLConnection.HTTP_OK) {
                        if (!silent) {
                            showToast(activityRef, "检查更新失败 (HTTP $code)")
                        }
                        return@execute
                    }

                    val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val json = JSONObject(body)
                    if (!json.optBoolean("ok", false)) {
                        if (!silent) {
                            showToast(activityRef, "检查更新失败：${json.optString("error", "unknown")}")
                        }
                        return@execute
                    }
                    if (!json.optBoolean("available", false)) {
                        if (!silent) {
                            showToast(activityRef, "当前服务器尚未发布更新包")
                        }
                        return@execute
                    }

                    val versionCode = json.optInt("versionCode", 0)
                    val versionName = json.optString("versionName", "").trim()
                    val bytes = json.optLong("bytes", 0L)
                    val sha256 = json.optString("sha256", "").trim().lowercase(Locale.US)
                    val downloadPath = json.optString("downloadPath", "/api/android/apk").trim()

                    if (versionCode <= 0 ||
                        versionName.isEmpty() ||
                        sha256.length != 64 ||
                        bytes !in 1L..MAX_APK_BYTES ||
                        !isSafeRelativeDownloadPath(downloadPath)
                    ) {
                        if (!silent) {
                            showToast(activityRef, "服务器返回的版本元数据无效")
                        }
                        return@execute
                    }

                    val downloadUrl = "$serverUrl$downloadPath"
                    if (!isSameOrigin(serverUrl, downloadUrl)) {
                        if (!silent) {
                            showToast(activityRef, "服务器返回的下载地址不安全")
                        }
                        return@execute
                    }

                    if (versionCode <= BuildConfig.VERSION_CODE) {
                        if (!silent) {
                            showToast(activityRef, "已是最新版本 (v${BuildConfig.VERSION_NAME})")
                        }
                        return@execute
                    }

                    val info = ReleaseInfo(
                        versionCode = versionCode,
                        versionName = versionName,
                        bytes = bytes,
                        sha256 = sha256,
                        downloadUrl = downloadUrl
                    )

                    val act = activityRef.get() ?: return@execute
                    act.runOnUiThread {
                        if (act.isFinishing || act.isDestroyed) return@runOnUiThread
                        val mbStr = String.format(Locale.US, "%.2f", info.bytes / 1048576.0)
                        MaterialAlertDialogBuilder(act)
                            .setTitle("发现新版本 v${info.versionName}")
                            .setMessage("当前版本：v${BuildConfig.VERSION_NAME}\n安装包大小：${mbStr} MB\n直接从个人网关安全下载并校验 SHA-256。")
                            .setPositiveButton("立即下载安装") { _, _ ->
                                downloadAndInstall(act, info)
                            }
                            .setNegativeButton("稍后", null)
                            .show()
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (err: Exception) {
                if (!silent) {
                    showToast(activityRef, "检查更新异常：${err.message ?: "网络不可用"}")
                }
            } finally {
                inFlight.set(false)
            }
        }
    }

    fun downloadAndInstall(activity: AppCompatActivity, info: ReleaseInfo) {
        if (!inFlight.compareAndSet(false, true)) {
            if (!activity.isFinishing && !activity.isDestroyed) {
                Toast.makeText(activity, "已有更新任务正在进行中", Toast.LENGTH_SHORT).show()
            }
            return
        }

        val appContext = activity.applicationContext
        val activityRef = WeakReference(activity)
        activeActivityRef = activityRef
        downloadCancelled.set(false)

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
                .setNegativeButton("取消") { d, _ ->
                    downloadCancelled.set(true)
                    executor.execute {
                        runCatching { activeConn?.disconnect() }
                    }
                    runCatching { d.dismiss() }
                }
                .show()
            activeDialog = dialog

            executor.execute {
                var outFile: File? = null
                try {
                    val serverUrl = ServerPrefs.getServerUrl(appContext).trimEnd('/')
                    if (info.bytes !in 1L..MAX_APK_BYTES || !isSameOrigin(serverUrl, info.downloadUrl)) {
                        throw IllegalStateException("非法的同源下载地址")
                    }

                    val updatesDir = File(appContext.cacheDir, "updates").apply { mkdirs() }
                    pendingInstallFile = null
                    pendingInstallSha256 = null
                    updatesDir.listFiles()?.forEach { runCatching { it.delete() } }
                    val targetFile = File(updatesDir, "AGY-Studio-Remote-update.apk")
                    outFile = targetFile

                    val cookie = CookieManager.getInstance().getCookie(serverUrl).orEmpty()
                    val conn = (URL(info.downloadUrl).openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        instanceFollowRedirects = false
                        connectTimeout = 10000
                        readTimeout = 30000
                        if (cookie.isNotBlank()) {
                            setRequestProperty("Cookie", cookie)
                        }
                    }
                    activeConn = conn

                    try {
                        val code = conn.responseCode
                        val contentType = conn.contentType.orEmpty().lowercase(Locale.US)
                        if (code in 300..399 || contentType.contains("text/html")) {
                            throw IllegalStateException("登录态已过期，请刷新页面重新登录后再下载")
                        }
                        if (code != HttpURLConnection.HTTP_OK) {
                            throw IllegalStateException("下载失败 (HTTP $code)")
                        }
                        if (conn.contentLengthLong > 0L && conn.contentLengthLong != info.bytes) {
                            throw IllegalStateException("安装包大小校验失败")
                        }

                        val totalBytes = info.bytes
                        val digest = MessageDigest.getInstance("SHA-256")
                        val buf = ByteArray(8192)
                        var downloaded = 0L
                        var lastUiUpdateMs = 0L

                        conn.inputStream.use { input ->
                            FileOutputStream(targetFile).use { output ->
                                while (true) {
                                    if (downloadCancelled.get()) {
                                        throw CancellationException("已取消更新下载")
                                    }
                                    val read = input.read(buf)
                                    if (read <= 0) break
                                    if (downloadCancelled.get()) {
                                        throw CancellationException("已取消更新下载")
                                    }
                                    downloaded += read
                                    if (downloaded > info.bytes || downloaded > MAX_APK_BYTES) {
                                        throw IllegalStateException("安装包大小超出预期，已中止下载")
                                    }
                                    output.write(buf, 0, read)
                                    digest.update(buf, 0, read)

                                    val nowMs = System.currentTimeMillis()
                                    if (nowMs - lastUiUpdateMs >= 80L || downloaded >= totalBytes) {
                                        lastUiUpdateMs = nowMs
                                        val pct = if (totalBytes > 0) ((downloaded * 100) / totalBytes).toInt().coerceIn(0, 100) else 0
                                        val dlMb = String.format(Locale.US, "%.2f", downloaded / 1048576.0)
                                        val totMb = String.format(Locale.US, "%.2f", totalBytes / 1048576.0)
                                        activityRef.get()?.let { act ->
                                            act.runOnUiThread {
                                                if (!act.isFinishing && !act.isDestroyed && dialog.isShowing) {
                                                    progressBar.progress = pct
                                                    statusText.text = "已下载 $dlMb / $totMb MB ($pct%)"
                                                }
                                            }
                                        }
                                    }
                                }
                                output.fd.sync()
                            }
                        }

                        val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                        if (downloaded != info.bytes ||
                            targetFile.length() != info.bytes ||
                            !actualSha.equals(info.sha256, ignoreCase = true)
                        ) {
                            runCatching { targetFile.delete() }
                            throw IllegalStateException("安装包校验失败，请重试")
                        }

                        pendingInstallFile = targetFile
                        pendingInstallSha256 = info.sha256
                        activityRef.get()?.let { act ->
                            act.runOnUiThread {
                                runCatching { if (dialog.isShowing) dialog.dismiss() }
                                if (activeDialog === dialog) activeDialog = null
                                if (!act.isFinishing && !act.isDestroyed) {
                                    installApk(act, targetFile)
                                }
                            }
                        }
                    } finally {
                        if (activeConn === conn) activeConn = null
                        conn.disconnect()
                    }
                } catch (err: CancellationException) {
                    runCatching { outFile?.delete() }
                    activityRef.get()?.let { act ->
                        act.runOnUiThread {
                            runCatching { if (dialog.isShowing) dialog.dismiss() }
                            if (activeDialog === dialog) activeDialog = null
                        }
                    }
                    showToast(activityRef, err.message ?: "已取消更新下载")
                } catch (err: Exception) {
                    runCatching { outFile?.delete() }
                    activityRef.get()?.let { act ->
                        act.runOnUiThread {
                            runCatching { if (dialog.isShowing) dialog.dismiss() }
                            if (activeDialog === dialog) activeDialog = null
                        }
                    }
                    if (!downloadCancelled.get()) {
                        showToast(activityRef, err.message ?: "安装包校验失败，请重试")
                    }
                } finally {
                    inFlight.set(false)
                }
            }
        }
    }

    fun resumePendingInstall(activity: AppCompatActivity) {
        val file = pendingInstallFile ?: return
        val expectedSha = pendingInstallSha256 ?: return
        if (!file.exists()) {
            pendingInstallFile = null
            pendingInstallSha256 = null
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            return
        }
        if (!inFlight.compareAndSet(false, true)) return
        val activityRef = WeakReference(activity)
        executor.execute {
            try {
                if (!file.exists()) {
                    pendingInstallFile = null
                    pendingInstallSha256 = null
                    return@execute
                }
                val digest = MessageDigest.getInstance("SHA-256")
                val buf = ByteArray(8192)
                FileInputStream(file).use { input ->
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        digest.update(buf, 0, read)
                    }
                }
                val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                if (!actualSha.equals(expectedSha, ignoreCase = true)) {
                    pendingInstallFile = null
                    pendingInstallSha256 = null
                    runCatching { file.delete() }
                    showToast(activityRef, "待安装更新包校验失效，请重新检查更新")
                    return@execute
                }
                activityRef.get()?.let { act ->
                    act.runOnUiThread {
                        if (!act.isFinishing && !act.isDestroyed) {
                            installApk(act, file)
                        }
                    }
                }
            } catch (_: Exception) {
            } finally {
                inFlight.set(false)
            }
        }
    }

    fun onActivityDestroyed(activity: AppCompatActivity) {
        val cur = activeActivityRef?.get()
        if (cur === activity || cur == null) {
            runCatching {
                if (activeDialog?.isShowing == true) activeDialog?.dismiss()
            }
            activeDialog = null
            if (inFlight.get()) {
                downloadCancelled.set(true)
                executor.execute {
                    runCatching { activeConn?.disconnect() }
                }
            }
        }
    }

    private fun installApk(activity: AppCompatActivity, apkFile: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(activity, "请允许 AGY Remote 安装应用更新，授权后返回将自动继续安装", Toast.LENGTH_LONG).show()
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
            pendingInstallFile = null
            pendingInstallSha256 = null
            activity.startActivity(installIntent)
        } catch (err: Exception) {
            Toast.makeText(activity, "无法拉起系统安装器：${err.message ?: "unknown"}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showToast(activityRef: WeakReference<AppCompatActivity>, msg: String) {
        val activity = activityRef.get() ?: return
        activity.runOnUiThread {
            if (!activity.isFinishing && !activity.isDestroyed) {
                Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
