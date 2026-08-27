# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.kts.

# Keep llama.cpp native methods
-keep class com.tglocaldigest.llama.** { *; }
-dontwarn com.tglocaldigest.llama.**

# TDLib
-keep class org.drinkless.td.libcore.telegram.** { *; }
-dontnote org.drinkless.td.libcore.telegram.**

# Moshi
-keepattributes *Annotation*
-keep class com.tglocaldigest.data.model.** { *; }
