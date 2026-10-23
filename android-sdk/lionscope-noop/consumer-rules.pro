# OkHttp is compileOnly: only Lionscope.okHttpInterceptor() uses it, so apps without OkHttp (which never call it)
# must still shrink without missing-class errors.
-dontwarn okhttp3.**
-dontwarn okio.**
