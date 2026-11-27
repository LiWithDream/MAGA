package com.agystudio.remote

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity(), NativeBridge.HostActions {
    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var errorOverlay: LinearLayout
    private lateinit var errorDetailText: TextView

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var lastBackPressedMs: Long = 0L
    private var lastThreeFingerTriggerMs: Long = 0L
    private var pageLoadedOnce: Boolean = false
    private var pendingSharedMediaJson: String? = null
    private var pendingFocusCascadeId: String? = null
    private var pendingLaunchUrl: String? = null
    private var lastInsetsJson: String? = null

    private val ioExecutor = Executors.newSingleThreadExecutor()

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = fileUploadCallback
        fileUploadCallback = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode != RESULT_OK || result.data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val data = result.data!!
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let { uris.add(it) }
            }
        }
        if (uris.isEmpty()) {
            data.data?.let { uris.add(it) }
        }
        callback.onReceiveValue(if (uris.isNotEmpty()) uris.toTypedArray() else null)
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Result handled automatically when posting notifications */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        applyEdgeToEdgeChrome()
        super.onCreate(savedInstanceState)

        NotificationHelper.ensureChannels(this)
        buildContentView()
        configureWebView()
        bindWindowInsets()
        bindBackGesture()

        handleIncomingIntent(intent)
        loadCurrentServer(clearCache = false)
    }

    private fun applyEdgeToEdgeChrome() {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT)
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.navigationBarDividerColor = Color.TRANSPARENT
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        syncSystemBarIconAppearance()
    }

    private fun syncSystemBarIconAppearance() {
        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = !isDark
        controller.isAppearanceLightNavigationBars = !isDark
    }

    private fun buildContentView() {
        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val bgColor = if (isDark) Color.parseColor("#212120") else Color.parseColor("#FFFFFF")
        val fgColor = if (isDark) Color.parseColor("#FAF9F5") else Color.parseColor("#1F1E1D")

        rootContainer = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(bgColor)
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(bgColor)
            overScrollMode = View.OVER_SCROLL_NEVER
        }

        val density = resources.displayMetrics.density
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                (3 * density).toInt()
            ).apply {
                gravity = Gravity.TOP
            }
            max = 100
            visibility = View.GONE
        }

        errorDetailText = TextView(this).apply {
            text = "无法连接到 AGY Studio 远程服务"
            textSize = 14f
            setTextColor(fgColor)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, (16 * density).toInt())
        }

        val retryBtn = Button(this).apply {
            text = "重新连接"
            setOnClickListener { loadCurrentServer(clearCache = false) }
        }
        val switchServerBtn = Button(this).apply {
            text = "切换服务器地址"
            setOnClickListener { onOpenSettings() }
        }

        errorOverlay = LinearLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding((28 * density).toInt(), (28 * density).toInt(), (28 * density).toInt(), (28 * density).toInt())
            setBackgroundColor(bgColor)
            visibility = View.GONE
            addView(errorDetailText)
            addView(retryBtn)
            addView(switchServerBtn)
        }

        rootContainer.addView(webView)
        rootContainer.addView(progressBar)
        rootContainer.addView(errorOverlay)
        setContentView(rootContainer)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            val cleanUa = userAgentString.replace("; wv)", ")").replace("Version/4.0 ", "")
            userAgentString = "$cleanUa AGYStudioRemoteAndroid/${BuildConfig.VERSION_NAME}"
        }

        webView.addJavascriptInterface(NativeBridge(this), "__agyNative")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress in 1..99) {
                    progressBar.visibility = View.VISIBLE
                    progressBar.progress = newProgress
                } else {
                    progressBar.visibility = View.GONE
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback
                return try {
                    val acceptTypes = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() }.orEmpty()
                    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = if (acceptTypes.size == 1) acceptTypes[0] else "image/*"
                        if (acceptTypes.size > 1) {
                            putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes.toTypedArray())
                        }
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    filePickerLauncher.launch(Intent.createChooser(intent, "选择图片附件"))
                    true
                } catch (_: Exception) {
                    fileUploadCallback = null
                    false
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val req = request ?: return false
                val uri = req.url ?: return false
                val scheme = uri.scheme?.lowercase() ?: return false
                if (scheme != "http" && scheme != "https") {
                    openExternally(uri)
                    return true
                }
                // Keep all redirects, programmatic navigations, and server/auth hosts inside WebView
                if (req.isRedirect || !req.hasGesture() || isAllowedInAppHost(uri.host)) {
                    return false
                }
                openExternally(uri)
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageLoadedOnce = true
                errorOverlay.visibility = View.GONE
                CookieManager.getInstance().flush()
                pushLastInsetsToWeb()
                flushPendingDispatches()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    val desc = error?.description?.toString().orEmpty()
                    errorDetailText.text = "连接失败：$desc\n(${ServerPrefs.getServerUrl(this@MainActivity)})"
                    errorOverlay.visibility = View.VISIBLE
                }
            }
        }
    }

    private fun isAllowedInAppHost(host: String?): Boolean {
        val target = host?.lowercase()?.trim() ?: return false
        val serverHost = Uri.parse(ServerPrefs.getServerUrl(this)).host?.lowercase()?.trim()
        if (!serverHost.isNullOrEmpty()) {
            if (target == serverHost) return true
            val parts = serverHost.split(".")
            if (parts.size >= 2) {
                val rootDomain = parts.takeLast(2).joinToString(".")
                if (target == rootDomain || target.endsWith(".$rootDomain")) return true
            }
        }
        val authDomains = listOf(
            "cloudflareaccess.com",
            "cloudflare.com",
            "google.com",
            "googleusercontent.com",
            "gstatic.com",
            "github.com",
            "githubusercontent.com",
            "microsoftonline.com",
            "live.com",
            "okta.com",
            "auth0.com"
        )
        return authDomains.any { target == it || target.endsWith(".$it") }
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
        }
    }

    private fun bindWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density.coerceAtLeast(1f)

            // When keyboard is open, shrink WebView bottom margin to sit flush above IME;
            // when keyboard is closed, let WebView extend edge-to-edge behind the transparent gesture pill.
            val lp = webView.layoutParams as FrameLayout.LayoutParams
            val targetBottomMargin = if (ime.bottom > 0) ime.bottom else 0
            if (lp.bottomMargin != targetBottomMargin) {
                lp.bottomMargin = targetBottomMargin
                webView.layoutParams = lp
            }

            val topDp = (sys.top / density)
            val bottomDp = if (ime.bottom > 0) 0f else (sys.bottom / density)
            val leftDp = (sys.left / density)
            val rightDp = (sys.right / density)
            val imeDp = (ime.bottom / density)

            val payload = JSONObject().apply {
                put("top", topDp.toDouble())
                put("bottom", bottomDp.toDouble())
                put("left", leftDp.toDouble())
                put("right", rightDp.toDouble())
                put("imeBottom", imeDp.toDouble())
            }.toString()
            lastInsetsJson = payload
            pushLastInsetsToWeb()
            insets
        }
        ViewCompat.requestApplyInsets(rootContainer)
    }

    private fun pushLastInsetsToWeb() {
        val json = lastInsetsJson ?: return
        if (!pageLoadedOnce) return
        webView.post {
            webView.evaluateJavascript(
                "window.__agyApplyNativeInsets && window.__agyApplyNativeInsets($json);",
                null
            )
        }
    }

    private fun bindBackGesture() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (errorOverlay.visibility == View.VISIBLE) {
                    handleExitConfirmation()
                    return
                }
                webView.evaluateJavascript(
                    "(function(){ return (typeof window.__agyNativeBack === 'function' && window.__agyNativeBack()) ? '1' : '0'; })()"
                ) { raw ->
                    val handled = raw == "\"1\"" || raw == "1" || raw == "true"
                    if (!handled) {
                        if (webView.canGoBack()) {
                            webView.goBack()
                        } else {
                            handleExitConfirmation()
                        }
                    }
                }
            }
        })
    }

    private fun handleExitConfirmation() {
        val now = System.currentTimeMillis()
        if (now - lastBackPressedMs < 2000L) {
            finish()
        } else {
            lastBackPressedMs = now
            Toast.makeText(this, "再按一次退出 AGY Remote", Toast.LENGTH_SHORT).show()
        }
    }

    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        if (ev != null && ev.actionMasked == MotionEvent.ACTION_POINTER_DOWN && ev.pointerCount == 3) {
            val now = System.currentTimeMillis()
            if (now - lastThreeFingerTriggerMs > 800L) {
                lastThreeFingerTriggerMs = now
                onOpenSettings()
                return true
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
        val launchUrl = pendingLaunchUrl
        if (!launchUrl.isNullOrEmpty()) {
            pendingLaunchUrl = null
            webView.loadUrl(launchUrl)
        }
        flushPendingDispatches()
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.action == Intent.ACTION_VIEW) {
            val viewUri = intent.data
            if (viewUri != null && (viewUri.scheme == "https" || viewUri.scheme == "http") && isAllowedInAppHost(viewUri.host)) {
                pendingLaunchUrl = viewUri.toString()
            }
        }
        val focusCid = intent.getStringExtra(NotificationHelper.EXTRA_CASCADE_ID)?.trim()
        if (!focusCid.isNullOrEmpty()) {
            pendingFocusCascadeId = focusCid
        }

        val action = intent.action
        val sharedUris = mutableListOf<Uri>()
        if (action == Intent.ACTION_SEND && intent.type?.startsWith("image/") == true) {
            val single = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            if (single != null) sharedUris.add(single)
        } else if (action == Intent.ACTION_SEND_MULTIPLE && intent.type?.startsWith("image/") == true) {
            val multi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
            }
            if (!multi.isNullOrEmpty()) sharedUris.addAll(multi)
        }

        if (sharedUris.isNotEmpty()) {
            ioExecutor.execute {
                val json = ShareMediaHelper.encodeUrisToJson(applicationContext, sharedUris)
                if (json != null) {
                    runOnUiThread {
                        pendingSharedMediaJson = json
                        flushPendingDispatches()
                    }
                }
            }
        }
    }

    private fun flushPendingDispatches() {
        if (!pageLoadedOnce) return
        val cid = pendingFocusCascadeId
        if (!cid.isNullOrEmpty()) {
            pendingFocusCascadeId = null
            val quoted = JSONObject.quote(cid)
            webView.post {
                webView.evaluateJavascript(
                    "window.__agyFocusConversation && window.__agyFocusConversation($quoted);",
                    null
                )
            }
        }
        val mediaJson = pendingSharedMediaJson
        if (!mediaJson.isNullOrEmpty()) {
            pendingSharedMediaJson = null
            webView.post {
                webView.evaluateJavascript(
                    "window.__agyReceiveSharedMedia && window.__agyReceiveSharedMedia($mediaJson);",
                    null
                )
            }
        }
    }

    private fun loadCurrentServer(clearCache: Boolean) {
        errorOverlay.visibility = View.GONE
        if (clearCache) {
            webView.clearCache(true)
        }
        val targetUrl = pendingLaunchUrl?.takeIf { it.isNotBlank() } ?: ServerPrefs.getServerUrl(this)
        pendingLaunchUrl = null
        webView.loadUrl(targetUrl)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        syncSystemBarIconAppearance()
        ViewCompat.requestApplyInsets(rootContainer)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        ioExecutor.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    override fun onOpenSettings() {
        runOnUiThread {
            SettingsDialog.show(
                context = this,
                onServerUrlUpdated = { _ -> loadCurrentServer(clearCache = false) },
                onForceReload = { clear -> loadCurrentServer(clearCache = clear) }
            )
        }
    }

    override fun onNotify(title: String, body: String, tag: String, category: String, cascadeId: String) {
        runOnUiThread {
            if (!NotificationHelper.hasNotificationPermission(this)) {
                onRequestNotificationPermission()
                return@runOnUiThread
            }
            NotificationHelper.showNotification(this, title, body, tag, category, cascadeId)
        }
    }

    override fun onVibrate(timings: LongArray) {
        NotificationHelper.vibratePattern(applicationContext, timings)
    }

    override fun onRequestNotificationPermission() {
        runOnUiThread {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !NotificationHelper.hasNotificationPermission(this)) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    override fun onReloadPage(clearCache: Boolean) {
        runOnUiThread {
            loadCurrentServer(clearCache = clearCache)
        }
    }

    override fun getCurrentServerUrl(): String = ServerPrefs.getServerUrl(this)
}
