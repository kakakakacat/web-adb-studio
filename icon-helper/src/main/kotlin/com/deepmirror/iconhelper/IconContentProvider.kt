package com.deepmirror.iconhelper

import android.content.ComponentName
import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * Headless helper that exposes any installed app's launcher icon as a PNG so a desktop tool
 * (ADB Studio) can read it over adb without depending on the DeepMirror launcher process:
 *
 *     adb exec-out content read --uri content://com.deepmirror.iconhelper.icons/<packageName>
 *
 * Optional `?size=<px>` sets the output edge length (default [DEFAULT_SIZE]).
 *
 * Icons are resolved through the framework's PackageManager (launcher-activity icon, falling back
 * to the application icon), so adaptive icons, custom icon resource names, and per-app density are
 * all rendered correctly — unlike unzipping and guessing `ic_launcher` out of the APK.
 *
 * This app declares no launcher activity: it is invisible in the app drawer and only serves this
 * provider. It needs no system signature — just QUERY_ALL_PACKAGES and an exported provider.
 */
class IconContentProvider : ContentProvider() {

    companion object {
        const val AUTHORITY = "com.deepmirror.iconhelper.icons"
        private const val TAG = "IconHelper"

        private const val DEFAULT_SIZE = 192
        private const val MIN_SIZE = 24
        private const val MAX_SIZE = 512
    }

    override fun onCreate(): Boolean = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val packageName = uri.lastPathSegment ?: return null
        val size = uri.getQueryParameter("size")?.toIntOrNull()
            ?.coerceIn(MIN_SIZE, MAX_SIZE) ?: DEFAULT_SIZE

        val png = runCatching { renderIconPng(packageName, size) }
            .onFailure { Log.e(TAG, "renderIconPng failed for $packageName", it) }
            .getOrNull() ?: return null

        // Stream the bytes back over a pipe — no temp file.
        val pipe = ParcelFileDescriptor.createPipe()
        val readSide = pipe[0]
        val writeSide = pipe[1]
        thread(name = "icon-pipe") {
            ParcelFileDescriptor.AutoCloseOutputStream(writeSide).use { out ->
                runCatching { out.write(png) }
            }
        }
        return readSide
    }

    private fun renderIconPng(packageName: String, size: Int): ByteArray? {
        val drawable = resolveIcon(packageName) ?: return null
        val bitmap = drawableToBitmap(drawable, size)
        return ByteArrayOutputStream().use { bos ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)
            bos.toByteArray()
        }
    }

    /** Launcher-activity icon first (closest to what a launcher shows), then the application icon. */
    private fun resolveIcon(packageName: String): Drawable? {
        val pm = context?.packageManager ?: return null

        val launchComponent: ComponentName? =
            pm.getLaunchIntentForPackage(packageName)?.component
        if (launchComponent != null) {
            runCatching { return pm.getActivityIcon(launchComponent) }
        }
        return runCatching { pm.getApplicationIcon(packageName) }
            .recoverCatching { throw it }
            .getOrElse {
                if (it is PackageManager.NameNotFoundException) null else throw it
            }
    }

    private fun drawableToBitmap(drawable: Drawable, size: Int): Bitmap {
        (drawable as? BitmapDrawable)?.bitmap?.let {
            return Bitmap.createScaledBitmap(it, size, size, true)
        }
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)
        return bitmap
    }

    // ===================== Unsupported =====================

    override fun getType(uri: Uri): String = "image/png"

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): Cursor? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?
    ): Int = 0
}
