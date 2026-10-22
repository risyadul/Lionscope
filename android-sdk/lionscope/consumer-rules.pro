# androidx.startup instantiates the initializer reflectively from manifest meta-data.
-keep class io.github.risyadul.lionscope.LionscopeInitializer { <init>(); }

# Inflation tracking delegates to AppCompat by name and through these public methods. If a shrunk build renamed
# them, AppCompat activities would be mistaken for plain ones and lose AppCompat's widget substitution.
-keepnames class androidx.appcompat.app.AppCompatActivity
-keepnames class androidx.appcompat.app.AppCompatDelegate
-keepclassmembers class androidx.appcompat.app.AppCompatActivity {
    public androidx.appcompat.app.AppCompatDelegate getDelegate();
}
-keepclassmembers class androidx.appcompat.app.AppCompatDelegate {
    public android.view.View createView(android.view.View, java.lang.String, android.content.Context, android.util.AttributeSet);
}
