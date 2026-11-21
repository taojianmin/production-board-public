package com.scjd.board;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 车间生产看板：全屏打开 NAS 上的看板网页 */
public class MainActivity extends Activity {
    static final String DEFAULT_URL = "https://board.example.invalid/";
    static final int PICK_FILE = 7;

    WebView web;
    View errorView;
    TextView errorText;
    FrameLayout root;
    ValueCallback<Uri[]> fileCb;
    String loadedDay = "";
    boolean mainFailed = false;

    SharedPreferences prefs() { return getSharedPreferences("board", Context.MODE_PRIVATE); }
    String boardUrl() { return prefs().getString("url", DEFAULT_URL); }
    static String today() { return new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date()); }
    boolean dark() { return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES; }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setDecorFitsSystemWindows(false);

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bar));
        // 留出状态栏、挖孔、底部手势条和键盘的位置，网页不会被挡住
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });

        web = new WebView(this);
        setupWeb();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        styleBars();

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }

        if (saved != null) web.restoreState(saved);
        else load();
    }

    void styleBars() {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        c.setSystemBarsAppearance(dark() ? 0 : light, light);
    }

    void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " SCJDBoardApp/1.0");
        // 记住看板的登录状态（登录一次能用 180 天）
        CookieManager.getInstance().setAcceptCookie(true);
        web.setBackgroundColor(getColor(R.color.bg));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "SCJDApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl(), home = Uri.parse(boardUrl());
                if (home.getHost() != null && home.getHost().equals(u.getHost())) return false;
                openOutside(u);
                return true;
            }
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { mainFailed = false; }
            @Override
            public void onPageFinished(WebView v, String url) {
                if (mainFailed) return;
                errorView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                loadedDay = today();
                // 网页里的「打印」改用安卓的打印（可以存成 PDF）
                v.evaluateJavascript("window.print=function(){document.querySelectorAll('details').forEach(function(x){x.open=true});setTimeout(function(){SCJDApp.print(document.title)},300)};", null);
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                mainFailed = true;
                showError("连不上看板（" + err.getDescription() + "）");
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "application/vnd.ms-excel",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "text/csv", "text/comma-separated-values", "application/octet-stream"});
                try { startActivityForResult(Intent.createChooser(i, "选择文件"), PICK_FILE); }
                catch (ActivityNotFoundException e) { fileCb = null; cb.onReceiveValue(null); return false; }
                return true;
            }
        });

        web.setDownloadListener((url, ua, cd, mime, len) -> openOutside(Uri.parse(url)));
    }

    void load() {
        errorView.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(boardUrl());
    }

    void openOutside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) {}
    }

    void goBack() {
        // 先回到「任务墙」，已经在任务墙再按一次就退到后台
        web.evaluateJavascript(
            "(function(){var b=document.querySelector('.tab[data-v=\"wall\"][aria-current=\"false\"]');if(b){b.click();window.scrollTo(0,0);return 1}return 0})()",
            r -> { if (!"1".equals(r)) moveTaskToBack(true); });
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { goBack(); }

    void showError(String msg) {
        errorText.setText(msg + "\n\n请确认手机能上网，NAS 也开着。\n看板地址：" + boardUrl());
        web.setVisibility(View.INVISIBLE);
        errorView.setVisibility(View.VISIBLE);
    }

    View buildErrorView() {
        float dp = getResources().getDisplayMetrics().density;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding((int) (28 * dp), 0, (int) (28 * dp), 0);
        box.setBackgroundColor(getColor(R.color.bg));
        int fg = dark() ? Color.parseColor("#E4E9EE") : Color.parseColor("#18222E");

        TextView t = new TextView(this);
        t.setText("生产看板");
        t.setTextSize(22);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextColor(fg);
        t.setGravity(Gravity.CENTER);
        box.addView(t);

        errorText = new TextView(this);
        errorText.setTextSize(15);
        errorText.setTextColor(fg);
        errorText.setGravity(Gravity.CENTER);
        errorText.setLineSpacing(0, 1.3f);
        errorText.setPadding(0, (int) (14 * dp), 0, (int) (22 * dp));
        box.addView(errorText);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> load());
        box.addView(retry, new LinearLayout.LayoutParams((int) (200 * dp), ViewGroup.LayoutParams.WRAP_CONTENT));

        Button addr = new Button(this);
        addr.setText("修改看板地址");
        addr.setOnClickListener(v -> askUrl());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams((int) (200 * dp), ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = (int) (8 * dp);
        box.addView(addr, lp);
        return box;
    }

    void askUrl() {
        EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        in.setText(boardUrl());
        in.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
            .setTitle("看板地址")
            .setMessage("一般不用改。NAS 换了地址时在这里改。")
            .setView(in)
            .setPositiveButton("保存", (d, w) -> {
                String u = in.getText().toString().trim();
                if (u.isEmpty()) u = DEFAULT_URL;
                if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
                if (!u.endsWith("/")) u += "/";
                prefs().edit().putString("url", u).apply();
                load();
            })
            .setNeutralButton("恢复默认", (d, w) -> { prefs().edit().remove("url").apply(); load(); })
            .setNegativeButton("取消", null)
            .show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // 隔夜打开时页面里的「今天」会过期，换天了就重新载入
        if (!loadedDay.isEmpty() && !loadedDay.equals(today())) load();
    }

    @Override
    protected void onPause() { web.onPause(); CookieManager.getInstance().flush(); super.onPause(); }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        root.setBackgroundColor(getColor(R.color.bar));
        web.setBackgroundColor(getColor(R.color.bg));
        styleBars();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK_FILE || fileCb == null) return;
        Uri[] r = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                r = new Uri[n];
                for (int i = 0; i < n; i++) r[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) r = new Uri[]{data.getData()};
        }
        fileCb.onReceiveValue(r);
        fileCb = null;
    }

    @Override
    protected void onDestroy() { web.destroy(); super.onDestroy(); }

    /** 给网页用的：打印 */
    class Bridge {
        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String name = (title == null || title.isEmpty() ? "生产看板" : title) + " " + today();
                pm.print(name, web.createPrintDocumentAdapter(name),
                    new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
            });
        }
    }
}
