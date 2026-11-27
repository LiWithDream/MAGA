package com.agystudio.remote

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
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
import androidx.core.content.FileProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity(), NativeBridge.HostActions {
    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var errorOverlay: LinearLayout
    private lateinit var errorDetailText: TextView

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraPhotoUri: Uri? = null
    private var lastBackPressedMs: Long = 0L
    private var lastThreeFingerTriggerMs: Long = 0L
    private var lastResumeDispatchMs: Long = 0L
    private var pageLoadedOnce: Boolean = false
    private var webReady: Boolean = false
    private var hasAutoCheckedUpdate: Boolean = false
    private var pendingSharedMediaJson: String? = null
    private var pendingFocusCascadeId: String? = null
    private var pendingLaunchUrl: String? = null
    private var lastInsetsJson: String? = null
    private var lastNetworkJson: String? = null
    private var lastNetworkOnline: Boolean = true
    private var lastNetworkTransport: String = ""
    private var networkCallbackRegistered: Boolean = false

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var pendingNetworkDispatch: Runnable? = null

    private val connectivityManager: ConnectivityManager?
        get() = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scheduleNetworkStateSync()
        }

        override fun onLost(network: Network) {
            scheduleNetworkStateSync()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            scheduleNetworkStateSync()
        }
    }

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = fileUploadCallback
        val cameraUri = pendingCameraPhotoUri
        fileUploadCallback = null
        pendingCameraPhotoUri = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val data = result.data
        val uris = mutableListOf<Uri>()
        data?.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let { uris.add(it) }
            }
        }
        if (uris.isEmpty()) {
            data?.data?.let { uris.add(it) }
        }
        if (uris.isEmpty() && cameraUri != null) {
            uris.add(cameraUri)
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
        KeepAliveService.onStoppedListener = {
            runOnUiThread {
                Toast.makeText(this, "已停止后台常驻监听", Toast.LENGTH_SHORT).show()
            }
        }
        if (ServerPrefs.isKeepAliveEnabled(this)) {
            KeepAliveService.start(this, "正在恢复后台连接…")
        }
        buildContentView()
        configureWebView(webView)
        bindWindowInsets()
        bindBackGesture()
        registerNetworkMonitor()

        handleIncomingIntent(intent)
        loadCurrentServer(clearCache = false)
    }

    private fun isNightMode(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

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
        val isDark = isNightMode()
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = !isDark
        controller.isAppearanceLightNavigationBars = !isDark
    }

    private fun applyThemeSurfaceColors() {
        val isDark = isNightMode()
        val bgColor = if (isDark) Color.parseColor("#212120") else Color.parseColor("#FFFFFF")
        val fgColor = if (isDark) Color.parseColor("#FAF9F5") else Color.parseColor("#1F1E1D")
        rootContainer.setBackgroundColor(bgColor)
        webView.setBackgroundColor(bgColor)
        errorOverlay.setBackgroundColor(bgColor)
        errorDetailText.setTextColor(fgColor)
    }

    private fun createConfiguredWebViewInstance(): WebView {
        val isDark = isNightMode()
        val bgColor = if (isDark) Color.parseColor("#212120") else Color.parseColor("#FFFFFF")
        return WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(bgColor)
            overScrollMode = View.OVER_SCROLL_NEVER
        }
    }

    private fun buildContentView() {
        val isDark = isNightMode()
        val bgColor = if (isDark) Color.parseColor("#212120") else Color.parseColor("#FFFFFF")
        val fgColor = if (isDark) Color.parseColor("#FAF9F5") else Color.parseColor("#1F1E1D")

        rootContainer = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(bgColor)
        }

        webView = createConfiguredWebViewInstance()

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

    private fun recreateWebViewAfterCrash() {
        val oldWebView = webView
        val oldIndex = rootContainer.indexOfChild(oldWebView).coerceAtLeast(0)
        rootContainer.removeView(oldWebView)
        try {
            oldWebView.destroy()
        } catch (_: Exception) {
        }
        pageLoadedOnce = false
        webReady = false
        webView = createConfiguredWebViewInstance()
        configureWebView(webView)
        rootContainer.addView(webView, oldIndex)
        ViewCompat.requestApplyInsets(rootContainer)
        Toast.makeText(this, "页面进程已自动恢复", Toast.LENGTH_SHORT).show()
        loadCurrentServer(clearCache = false)
    }

    private fun createCameraCaptureIntent(): Intent? {
        return try {
            val camDir = File(cacheDir, "camera").apply { mkdirs() }
            val photoFile = File(camDir, "agy_cam_${System.currentTimeMillis()}.jpg")
            val photoUri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", photoFile)
            pendingCameraPhotoUri = photoUri
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } catch (_: Exception) {
            pendingCameraPhotoUri = null
            null
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(targetWebView: WebView) {
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(targetWebView, true)

        targetWebView.settings.apply {
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
            // Use clean Chrome Mobile UA (no `; wv)` or custom suffix) so Google/Cloudflare OAuth allows in-app sign-in
            userAgentString = userAgentString.replace("; wv)", ")").replace("Version/4.0 ", "")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(targetWebView.settings, emptySet())
        }

        targetWebView.addJavascriptInterface(NativeBridge(this), "__agyNative")

        targetWebView.webChromeClient = object : WebChromeClient() {
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
                pendingCameraPhotoUri = null
                fileUploadCallback = filePathCallback
                return try {
                    val acceptTypes = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() }.orEmpty()
                    val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = if (acceptTypes.size == 1) acceptTypes[0] else "image/*"
                        if (acceptTypes.size > 1) {
                            putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes.toTypedArray())
                        }
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    val chooser = Intent.createChooser(galleryIntent, "选择图片或拍照")
                    val camIntent = createCameraCaptureIntent()
                    if (camIntent != null) {
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camIntent))
                    }
                    filePickerLauncher.launch(chooser)
                    true
                } catch (_: Exception) {
                    fileUploadCallback = null
                    pendingCameraPhotoUri = null
                    false
                }
            }
        }

        targetWebView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val req = request ?: return false
                val uri = req.url ?: return false
                val scheme = uri.scheme?.lowercase() ?: return false
                if (scheme != "http" && scheme != "https") {
                    // Block intent:// jumps back to Chrome during OAuth unless explicitly non-browser scheme
                    if (scheme == "intent" || scheme == "googlechrome" || scheme == "android-app") {
                        return true
                    }
                    openExternally(uri)
                    return true
                }
                val currentHost = view?.url?.let { runCatching { Uri.parse(it).host?.lowercase() }.getOrNull() }
                val serverHost = Uri.parse(ServerPrefs.getServerUrl(this@MainActivity)).host?.lowercase()?.trim()
                val inAuthFlow = !currentHost.isNullOrEmpty() && !serverHost.isNullOrEmpty() && currentHost != serverHost
                // Always keep server/Access redirects and active OAuth flows inside WebView;
                // user-tapped external links (e.g. Google Drive / GitHub) inside chat open externally.
                if (inAuthFlow || req.isRedirect || !req.hasGesture() || isServerOrAccessHost(uri.host)) {
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
                if (webReady) {
                    flushPendingDispatches()
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    val desc = error?.description?.toString().orEmpty()
                    errorDetailText.text = "连接失败：$desc\n(${ServerPrefs.getServerUrl(this@MainActivity)})\n网络恢复后将自动重连"
                    errorOverlay.visibility = View.VISIBLE
                }
            }

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                if (view !== webView) return true
                runOnUiThread { recreateWebViewAfterCrash() }
                return true
            }
        }
    }

    private fun isServerOrAccessHost(host: String?): Boolean {
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
        return target == "cloudflareaccess.com" || target.endsWith(".cloudflareaccess.com")
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
        }
    }

    private fun registerNetworkMonitor() {
        val cm = connectivityManager ?: return
        try {
            cm.registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        } catch (_: Exception) {
            networkCallbackRegistered = false
        }
        syncNetworkStateNow(pushToWeb = false)
    }

    private fun unregisterNetworkMonitor() {
        pendingNetworkDispatch?.let { mainHandler.removeCallbacks(it) }
        pendingNetworkDispatch = null
        if (!networkCallbackRegistered) return
        networkCallbackRegistered = false
        try {
            connectivityManager?.unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {
        }
    }

    private fun scheduleNetworkStateSync() {
        pendingNetworkDispatch?.let { mainHandler.removeCallbacks(it) }
        val task = Runnable { syncNetworkStateNow(pushToWeb = true) }
        pendingNetworkDispatch = task
        mainHandler.postDelayed(task, 250L)
    }

    private fun readCurrentNetworkState(): Pair<Boolean, String> {
        val cm = connectivityManager ?: return Pair(true, "unknown")
        val active = cm.activeNetwork ?: return Pair(false, "none")
        val caps = cm.getNetworkCapabilities(active) ?: return Pair(false, "none")
        val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        if (!hasInternet) return Pair(false, "none")
        val base = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val transport = if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) "$base+vpn" else base
        return Pair(true, transport)
    }

    private fun syncNetworkStateNow(pushToWeb: Boolean) {
        val (online, transport) = readCurrentNetworkState()
        val changed = online != lastNetworkOnline || transport != lastNetworkTransport
        lastNetworkOnline = online
        lastNetworkTransport = transport
        val payload = JSONObject().apply {
            put("online", online)
            put("transport", transport)
        }.toString()
        lastNetworkJson = payload

        if (online && errorOverlay.visibility == View.VISIBLE) {
            loadCurrentServer(clearCache = false)
            return
        }
        if (pushToWeb && changed) {
            pushLastNetworkToWeb()
        }
    }

    private fun pushLastNetworkToWeb() {
        val json = lastNetworkJson ?: return
        if (!webReady) return
        webView.post {
            webView.evaluateJavascript(
                "window.__agyNativeNetworkChange && window.__agyNativeNetworkChange($json);",
                null
            )
        }
    }

    private fun bindWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density.coerceAtLeast(1f)

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
        if (!pageLoadedOnce && !webReady) return
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
            webReady = false
            webView.loadUrl(launchUrl)
        } else if (webReady) {
            flushPendingDispatches()
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.action == Intent.ACTION_VIEW) {
            val viewUri = intent.data
            if (viewUri != null && (viewUri.scheme == "https" || viewUri.scheme == "http") && isServerOrAccessHost(viewUri.host)) {
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
                        if (webReady) flushPendingDispatches()
                    }
                }
            }
        }
    }

    private fun flushPendingDispatches() {
        if (!webReady) return
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
        webReady = false
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
        applyThemeSurfaceColors()
        ViewCompat.requestApplyInsets(rootContainer)
    }

    override fun onResume() {
        super.onResume()
        syncSystemBarIconAppearance()
        CookieManager.getInstance().flush()
        syncNetworkStateNow(pushToWeb = true)
        val now = System.currentTimeMillis()
        if (webReady && now - lastResumeDispatchMs > 600L) {
            lastResumeDispatchMs = now
            webView.post {
                webView.evaluateJavascript(
                    "window.__agyNativeResume && window.__agyNativeResume();",
                    null
                )
            }
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        KeepAliveService.onStoppedListener = null
        unregisterNetworkMonitor()
        ioExecutor.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    override fun onOpenSettings() {
        runOnUiThread {
            SettingsDialog.show(
                context = this,
                onServerUrlUpdated = { _ -> loadCurrentServer(clearCache = false) },
                onForceReload = { clear -> loadCurrentServer(clearCache = clear) },
                onKeepAliveToggled = { enabled -> onSetKeepAliveEnabled(enabled) },
                onCheckForUpdate = { onCheckForUpdate(false) }
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

    override fun onWebReady() {
        runOnUiThread {
            webReady = true
            pushLastInsetsToWeb()
            pushLastNetworkToWeb()
            flushPendingDispatches()
            if (!hasAutoCheckedUpdate) {
                hasAutoCheckedUpdate = true
                mainHandler.postDelayed({
                    if (!isFinishing && !isDestroyed) {
                        AppUpdater.checkForUpdate(this, silent = true)
                    }
                }, 3500L)
            }
        }
    }

    override fun getCurrentServerUrl(): String = ServerPrefs.getServerUrl(this)

    override fun isKeepAliveEnabled(): Boolean = ServerPrefs.isKeepAliveEnabled(this)

    override fun onSetKeepAliveEnabled(enabled: Boolean): Boolean {
        ServerPrefs.setKeepAliveEnabled(this, enabled)
        runOnUiThread {
            if (enabled) {
                if (!NotificationHelper.hasNotificationPermission(this)) {
                    onRequestNotificationPermission()
                }
                KeepAliveService.start(this, "后台实时监听已开启")
            } else {
                KeepAliveService.stop(this)
            }
        }
        return enabled
    }

    override fun onUpdateKeepAliveStatus(statusText: String) {
        if (KeepAliveService.isRunning) {
            KeepAliveService.updateStatus(this, statusText)
        }
    }

    override fun onCheckForUpdate(silent: Boolean) {
        AppUpdater.checkForUpdate(this, silent)
    }
}
