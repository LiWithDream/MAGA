package com.agystudio.remote

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

object ShareMediaHelper {
    private const val MAX_IMAGES = 4
    private const val MAX_DIMENSION = 1600
    private const val JPEG_QUALITY = 84

    fun encodeUrisToJson(context: Context, uris: List<Uri>): String? {
        val arr = JSONArray()
        for (uri in uris.take(MAX_IMAGES)) {
            val item = encodeSingleUri(context, uri) ?: continue
            arr.put(item)
        }
        return if (arr.length() > 0) arr.toString() else null
    }

    private fun encodeSingleUri(context: Context, uri: Uri): JSONObject? {
        return try {
            val resolver = context.contentResolver
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, bounds)
            }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

            var sampleSize = 1
            val longest = max(bounds.outWidth, bounds.outHeight)
            while (longest / sampleSize > MAX_DIMENSION * 2) {
                sampleSize *= 2
            }

            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
            val decoded = resolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, decodeOpts)
            } ?: return null

            val scaled = scaleDownIfNeeded(decoded)
            val baos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, baos)
            if (scaled !== decoded) scaled.recycle()
            decoded.recycle()

            val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
            val displayName = resolveDisplayName(context, uri)
            JSONObject().apply {
                put("name", displayName)
                put("mimeType", "image/jpeg")
                put("dataUrl", "data:image/jpeg;base64,$b64")
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun scaleDownIfNeeded(bitmap: Bitmap): Bitmap {
        val w = bitmap.width
        val h = bitmap.height
        val longest = max(w, h)
        if (longest <= MAX_DIMENSION) return bitmap
        val ratio = MAX_DIMENSION.toFloat() / longest.toFloat()
        val nextW = (w * ratio).roundToInt().coerceAtLeast(1)
        val nextH = (h * ratio).roundToInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, nextW, nextH, true)
    }

    private fun resolveDisplayName(context: Context, uri: Uri): String {
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val name = cursor.getString(0)?.trim()
                    if (!name.isNullOrEmpty()) return name
                }
            }
        } catch (_: Exception) {
        }
        return "shared-image.jpg"
    }
}
