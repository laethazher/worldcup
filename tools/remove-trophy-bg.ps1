# إزالة خلفية صورة الكأس (رقعة شطرنج أو لون موحّد) وإنتاج PNG بشفافية حقيقية.
# الاستعمال:
#   powershell -ExecutionPolicy Bypass -File tools\remove-trophy-bg.ps1 -In "المسار\الأصل.png" -Out "public\assets\brand\trophy.png"
# الخوارزمية (Saturation Matte): زحف من حواف الصورة عبر البكسلات المحايدة
# اللون فقط (رقعة الشفافية رمادية بينما الكأس ذهبي مُشبع) — لا قاعدة تشابه
# جيران إطلاقاً كي لا يتسرب الزحف عبر تدرجات المعدن الناعمة. منطقة الزحف
# تُمنح ألفا متدرجاً بحسب التشبع (حافة قصّ ناعمة طبيعياً)، والبقية معتمة.
# -IgnoreAlpha: يتجاهل قناة ألفا الموجودة ويعيد البناء من RGB (وضع الإنقاذ).
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$SatMax = 22,
  [int]$SatMin = 6,
  [switch]$IgnoreAlpha
)

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class TrophyBg {
  static int Sat(byte[] p, int i4) {
    int r = p[i4+2], g = p[i4+1], b = p[i4];
    int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
    return mx - mn;
  }

  public static void Process(string inPath, string outPath, int satMax, int satMin, bool ignoreAlpha) {
    Bitmap src = new Bitmap(inPath);
    Bitmap bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) g.DrawImage(src, 0, 0, src.Width, src.Height);
    src.Dispose();
    int w = bmp.Width, h = bmp.Height, n = w * h;
    BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    byte[] px = new byte[n * 4];
    Marshal.Copy(d.Scan0, px, 0, px.Length);

    // إن كانت الحواف شفافة أصلاً (وليس وضع الإنقاذ) فالملف جاهز — قصّ فقط
    int transparentBorder = 0, borderCount = 0;
    for (int x = 0; x < w; x++) { if (px[x*4+3] < 10) transparentBorder++; if (px[((h-1)*w+x)*4+3] < 10) transparentBorder++; borderCount += 2; }
    bool alreadyTransparent = !ignoreAlpha && transparentBorder > borderCount / 2;

    if (!alreadyTransparent) {
      // زحف عبر المحايدات فقط: sat <= satMax — الجسد الذهبي المشبع سدّ منيع،
      // فلا يصل الزحف للّمعات الداخلية شبه المحايدة المحاطة بالذهب.
      bool[] bg = new bool[n];
      Queue<int> q = new Queue<int>();
      Action<int> seed = i => { if (!bg[i] && Sat(px, i*4) <= satMax) { bg[i] = true; q.Enqueue(i); } };
      for (int x = 0; x < w; x++) { seed(x); seed((h-1)*w + x); }
      for (int y = 0; y < h; y++) { seed(y*w); seed(y*w + w - 1); }
      int[] dx = { 1, -1, w, -w };
      while (q.Count > 0) {
        int i = q.Dequeue();
        for (int k = 0; k < 4; k++) {
          int j = i + dx[k];
          if (j < 0 || j >= n) continue;
          if (dx[k] == 1  && j % w == 0) continue;
          if (dx[k] == -1 && i % w == 0) continue;
          if (bg[j] || Sat(px, j*4) > satMax) continue;
          bg[j] = true; q.Enqueue(j);
        }
      }
      // الألفا: منطقة الزحف متدرجة بالتشبع (محايد تماماً = 0، منطقة المزج جزئية)
      // وكل ما عداها معتم بالكامل (يستعيد أي ألفا مدمَّر عند -IgnoreAlpha)
      float span = Math.Max(1, satMax - satMin);
      for (int i = 0; i < n; i++) {
        if (bg[i]) {
          float k = (Sat(px, i*4) - satMin) / span;
          px[i*4+3] = (byte)(255 * Math.Min(1f, Math.Max(0f, k)));
        } else if (ignoreAlpha) px[i*4+3] = 255;
      }
    }

    // قصّ تلقائي لحدود المحتوى + هامش ٣٪
    int minX = w, minY = h, maxX = -1, maxY = -1;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++)
      if (px[(y*w+x)*4+3] > 8) { if (x<minX) minX=x; if (x>maxX) maxX=x; if (y<minY) minY=y; if (y>maxY) maxY=y; }
    Marshal.Copy(px, 0, d.Scan0, px.Length);
    bmp.UnlockBits(d);
    if (maxX < 0) throw new Exception("empty image after background removal");
    int mx2 = Math.Max((maxX-minX)/33, 4), my2 = Math.Max((maxY-minY)/33, 4);
    Rectangle crop = Rectangle.Intersect(new Rectangle(0, 0, w, h),
      new Rectangle(minX-mx2, minY-my2, maxX-minX+1+2*mx2, maxY-minY+1+2*my2));
    Bitmap outBmp = bmp.Clone(crop, PixelFormat.Format32bppArgb);
    bmp.Dispose();
    outBmp.Save(outPath, ImageFormat.Png);
    outBmp.Dispose();
    Console.WriteLine("saved " + outPath + " (" + crop.Width + "x" + crop.Height + (alreadyTransparent ? ", already transparent — cropped only" : "") + ")");
  }
}
"@

[TrophyBg]::Process((Resolve-Path $In).Path, $Out, $SatMax, $SatMin, [bool]$IgnoreAlpha)
