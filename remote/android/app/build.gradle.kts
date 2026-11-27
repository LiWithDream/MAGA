plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePath = System.getenv("AGY_KEYSTORE_PATH") ?: (project.findProperty("agyKeystorePath") as String?)
val keystorePassword = System.getenv("AGY_KEYSTORE_PASSWORD") ?: (project.findProperty("agyKeystorePassword") as String?)
val keyAliasProp = System.getenv("AGY_KEY_ALIAS") ?: (project.findProperty("agyKeyAlias") as String?) ?: "agy-remote"
val keyPasswordProp = System.getenv("AGY_KEY_PASSWORD") ?: (project.findProperty("agyKeyPassword") as String?) ?: keystorePassword

android {
    namespace = "com.agystudio.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agystudio.remote"
        minSdk = 26
        targetSdk = 35
        versionCode = 10302
        versionName = "1.3.2"
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://agy.miracleli.com\"")
    }

    signingConfigs {
        if (!keystorePath.isNullOrBlank() && !keystorePassword.isNullOrBlank() && file(keystorePath).exists()) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystorePassword
                keyAlias = keyAliasProp
                keyPassword = keyPasswordProp
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            val relSign = signingConfigs.findByName("release")
            signingConfig = relSign ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("com.google.android.material:material:1.12.0")
}
