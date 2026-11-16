import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app carries the module's version (ledger-module.json): one release, one number.
val moduleVersion: String = (JsonSlurper().parse(rootProject.file("../ledger-module.json")) as Map<*, *>)["version"] as String
val parts = moduleVersion.split(".").map { it.toInt() }

// Release builds are signed with the key GitHub holds (see README: "The phone app").
// The same key every time, or Android refuses to install an update over the app.
val keystorePath: String? = System.getenv("APP_KEYSTORE_FILE")

android {
    namespace = "app.ledger.importer"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.ledger.importer"
        minSdk = 26
        targetSdk = 35
        versionCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
        versionName = moduleVersion
        buildConfigField("String", "RELEASES_REPO", "\"mastifdogo/download_module\"")
        buildConfigField("String", "APK_NAME", "\"ledger-import.apk\"")
        buildConfigField("String", "MODULE_ID", "\"downloads\"")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("APP_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("APP_KEY_ALIAS")
                keyPassword = System.getenv("APP_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // Finds the receipt in the camera, straightens it and makes the PDF (Google Play services).
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0-beta1")
}
