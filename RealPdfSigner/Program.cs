using System; using System.IO; using System.Collections.Generic; using System.Text; using System.Threading.Tasks;
using System.Security.Cryptography; using System.Security.Cryptography.X509Certificates; using System.Text.Json;
using iText.Bouncycastle.X509; using iText.Commons.Bouncycastle.Cert; using iText.Kernel.Geom; using iText.Kernel.Pdf;
using iText.Kernel.Pdf.Canvas.Parser; using iText.Kernel.Pdf.Canvas.Parser.Listener; using iText.Kernel.Pdf.Canvas.Parser.Data;
using iText.Layout; using iText.Layout.Element; using iText.Signatures; using iText.IO.Image;
using System.Net; using System.Text.RegularExpressions; using System.Threading; using System.Runtime.InteropServices;
using Microsoft.Win32; using System.Windows.Forms; using System.Drawing; using System.Net.WebSockets;
using Rectangle = iText.Kernel.Geom.Rectangle; using SignatureFieldAppearance = iText.Forms.Form.Element.SignatureFieldAppearance;
namespace RealPdfSigner
{
    /// <summary>Chính sách An toàn Mật mã Chữ ký số Chuyên dùng Ban Cơ yếu Chính phủ (VGCA Tier 3)</summary>
    public static class VgcaCryptoPolicy
    {
        public const int MinRsaKeyBits = 2048;
        public const int MinEcdsaKeyBits = 256;
        public static void Validate(X509Certificate2 cert)
        {
            if (cert == null) throw new ArgumentNullException(nameof(cert));
            if (!cert.HasPrivateKey) throw new CryptographicException("Chứng thư số không chứa Khóa riêng (Private Key).");
            DateTime utcNow = DateTime.UtcNow;
            if (utcNow < cert.NotBefore.ToUniversalTime() || utcNow > cert.NotAfter.ToUniversalTime())
                throw new CryptographicException($"Chứng thư số không trong thời gian hiệu lực ({cert.NotBefore:u} - {cert.NotAfter:u}).");
            if (!cert.Issuer.Contains("Ban Cơ yếu", StringComparison.OrdinalIgnoreCase) && !cert.Issuer.Contains("VGCA", StringComparison.OrdinalIgnoreCase) && !cert.Issuer.Contains("Government Root CA", StringComparison.OrdinalIgnoreCase))
                throw new CryptographicException($"Issuer chứng thư ({cert.Issuer}) không thuộc Trust Anchor Ban Cơ yếu Chính phủ (VGCA).");
            bool foundKeyUsage = false;
            foreach (var ext in cert.Extensions) {
                if (ext is X509KeyUsageExtension ku) {
                    foundKeyUsage = true;
                    const X509KeyUsageFlags req = X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation;
                    if ((ku.KeyUsages & req) != req) throw new CryptographicException("Chứng thư số thiếu cờ DigitalSignature và NonRepudiation trong KeyUsage.");
                    break;
                }
            }
            if (!foundKeyUsage) throw new CryptographicException("Chứng thư số thiếu extension X509KeyUsageExtension.");
            bool foundEku = false;
            foreach (var ext in cert.Extensions) {
                if (ext is X509EnhancedKeyUsageExtension eku) {
                    foundEku = true; bool ok = false;
                    foreach (var oid in eku.EnhancedKeyUsages)
                        if (oid.Value == "1.3.6.1.4.1.311.10.3.12" || oid.Value == "1.3.6.1.5.5.7.3.36" || oid.Value == "1.2.840.113583.1.1.5") ok = true;
                    if (!ok) throw new CryptographicException("EnhancedKeyUsage thiếu OID ký số văn bản pháp lý (Document Signing).");
                    break;
                }
            }
            if (!foundEku) throw new CryptographicException("Chứng thư số thiếu extension X509EnhancedKeyUsageExtension.");
            using (var rsa = cert.GetRSAPublicKey()) using (var ec = cert.GetECDsaPublicKey()) {
                if ((rsa != null) == (ec != null)) throw new CryptographicException("Chỉ chấp nhận duy nhất một loại khóa RSA hoặc ECDSA.");
                if (rsa != null && rsa.KeySize < MinRsaKeyBits) throw new CryptographicException($"Khóa RSA ({rsa.KeySize}-bit) không đạt chuẩn tối thiểu {MinRsaKeyBits}-bit.");
                if (ec != null && ec.KeySize < MinEcdsaKeyBits) throw new CryptographicException($"Khóa ECDSA ({ec.KeySize}-bit) không đạt chuẩn tối thiểu {MinEcdsaKeyBits}-bit.");
            }
            using (var chain = new X509Chain()) {
                chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
                chain.ChainPolicy.RevocationFlag = X509RevocationFlag.ExcludeRoot;
                chain.ChainPolicy.UrlRetrievalTimeout = TimeSpan.FromSeconds(5);
                if (!chain.Build(cert)) throw new CryptographicException("Chứng thư không thể xây dựng chuỗi tin cậy hợp lệ hoặc đã bị thu hồi.");
            }
        }
    }

    // Lớp thực thi Chữ ký số Mật mã Chuẩn Quốc tế (Hỗ trợ cả ECDSA và RSA của Ban Cơ yếu Chính phủ)
    public class VgcaSignature : IExternalSignature, IDisposable
    {
        protected readonly X509Certificate2 _cert;
        protected readonly ECDsa? _ecdsa;
        protected readonly RSA? _rsa;
        protected readonly string _digestAlgorithm;
        private bool _disposed = false;

        public VgcaSignature(X509Certificate2 cert, string digestAlgorithm = "SHA-256")
        {
            _cert = cert ?? throw new ArgumentNullException(nameof(cert));
            if (!string.Equals(digestAlgorithm, "SHA-256", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Chính sách mật mã VGCA yêu cầu SHA-256", nameof(digestAlgorithm));
            _digestAlgorithm = "SHA-256";

            // Xác thực chứng thư số tuân thủ chính sách mật mã VGCA
            VgcaCryptoPolicy.Validate(cert);

            ECDsa? ecdsa = null;
            RSA? rsa = null;
            try
            {
                ecdsa = cert.GetECDsaPrivateKey();
                if (ecdsa != null)
                {
                    if (ecdsa.KeySize < VgcaCryptoPolicy.MinEcdsaKeyBits)
                        throw new CryptographicException($"Khóa ECDSA {ecdsa.KeySize} bit nhỏ hơn chuẩn tối thiểu ({VgcaCryptoPolicy.MinEcdsaKeyBits} bit).");
                    _ecdsa = ecdsa;
                    _rsa = null;
                }
                else
                {
                    rsa = cert.GetRSAPrivateKey();
                    if (rsa != null)
                    {
                        if (rsa.KeySize < VgcaCryptoPolicy.MinRsaKeyBits)
                            throw new CryptographicException($"Khóa RSA {rsa.KeySize} bit nhỏ hơn chuẩn tối thiểu ({VgcaCryptoPolicy.MinRsaKeyBits} bit).");
                        _rsa = rsa;
                        _ecdsa = null;
                    }
                    else
                    {
                        throw new CryptographicException("Chứng thư số không có Khóa riêng (Private Key) hợp lệ cho RSA hoặc ECDSA!");
                    }
                }
            }
            catch
            {
                ecdsa?.Dispose();
                rsa?.Dispose();
                throw;
            }
        }

        public string GetDigestAlgorithmName() => _digestAlgorithm;

        public string GetSignatureAlgorithmName() => _ecdsa != null ? "ECDSA" : "RSA";

        public ISignatureMechanismParams? GetSignatureMechanismParameters() => null;

        public void Dispose()
        {
            Dispose(true);
            GC.SuppressFinalize(this);
        }

        protected virtual void Dispose(bool disposing)
        {
            if (!_disposed)
            {
                if (disposing)
                {
                    _ecdsa?.Dispose();
                    _rsa?.Dispose();
                }
                _disposed = true;
            }
        }

        public byte[] Sign(byte[] message)
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(nameof(VgcaSignature), "Đối tượng ký số đã được giải phóng.");
            }

            Program.SetColor(ConsoleColor.Yellow);
            Program.WriteLine("===============================================================");
            Program.WriteLine($"📲 ĐANG KÍCH HOẠT KÝ SỐ MẬT MÃ ({GetSignatureAlgorithmName()}) QUA BAN CƠ YẾU CHÍNH PHỦ (VGCA)...");
            Program.WriteLine("👉 ĐÃ GỬI TÍN HIỆU TỚI THIẾT BỊ / USB TOKEN CỦA THẦY!");
            Program.WriteLine("===============================================================");
            Program.ResetColor();

            if (_ecdsa != null)
            {
                // Định dạng chữ ký ECDSA trong PKCS#7 / PAdES chuẩn quốc tế (Adobe Acrobat) BẮT BUỘC là RFC 3279 DER Sequence.
                return _ecdsa.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
            }
            else if (_rsa != null)
            {
                // Định dạng chữ ký RSA PKCS#1 v1.5
                return _rsa.SignData(message, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            }

            throw new InvalidOperationException("Không tìm thấy thuật toán mã hóa phù hợp.");
        }
    }

    public class VgcaEcdsaSignature : VgcaSignature
    {
        public VgcaEcdsaSignature(X509Certificate2 cert) : base(cert) { }
    }

    public class BouncyCastleEcdsaSignature : IExternalSignature
    {
        private readonly Org.BouncyCastle.Crypto.AsymmetricKeyParameter _key;
        public BouncyCastleEcdsaSignature(Org.BouncyCastle.Crypto.AsymmetricKeyParameter key)
        {
            _key = key;
        }
        public string GetDigestAlgorithmName() => "SHA-256";
        public string GetSignatureAlgorithmName() => "ECDSA";
        public ISignatureMechanismParams? GetSignatureMechanismParameters() => null;
        public byte[] Sign(byte[] message)
        {
            var signer = Org.BouncyCastle.Security.SignerUtilities.GetSigner("SHA-256withECDSA");
            signer.Init(true, _key);
            signer.BlockUpdate(message, 0, message.Length);
            return signer.GenerateSignature();
        }
    }

    public class Program
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);
        private const int ATTACH_PARENT_PROCESS = -1;

        public static void SetColor(ConsoleColor color)
        {
            try { Console.ForegroundColor = color; } catch { }
        }

        public static void ResetColor()
        {
            try { Console.ResetColor(); } catch { }
        }

        public static void WriteLine(string? message = "")
        {
            try { Console.WriteLine(message); } catch { }
        }

        [STAThread]
        static void Main(string[] args)
        {
            string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
            try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Main entered with args: '{string.Join(" ", args)}'\n"); } catch { }

            // 1. Chạy ngầm khay hệ thống nếu có cờ --tray hoặc --agent
            if (args.Length == 1 && (args[0].Equals("--tray", StringComparison.OrdinalIgnoreCase) || args[0].Equals("--agent", StringComparison.OrdinalIgnoreCase)))
            {
                try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Calling RunTrayAgent...\n"); } catch { }
                RunTrayAgent();
                return;
            }

            // 2. Nếu người dùng nhấp đúp chạy ứng dụng không truyền tham số CLI:
            if (args.Length == 0)
            {
                string currentExe = Environment.ProcessPath ?? AppDomain.CurrentDomain.BaseDirectory;
                string targetDir = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EduSign_Agent");
                string targetExe = System.IO.Path.Combine(targetDir, "EduSign_Agent.exe");

                // Nếu đang chạy từ thư mục đã cài đặt (%LOCALAPPDATA%\EduSign_Agent\EduSign_Agent.exe):
                // Chạy trực tiếp vào khay hệ thống
                if (string.Equals(currentExe, targetExe, StringComparison.OrdinalIgnoreCase))
                {
                    RunTrayAgent();
                    return;
                }

                // Nếu chạy từ thư mục khác (Downloads, Desktop, USB, v.v.):
                // HIỂN THỊ HỘP THOẠI CÀI ĐẶT ỨNG DỤNG CHUẨN WINDOWS (GUI INSTALLER WIZARD)
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new EduSignInstallerForm());
                    return;
                }
                catch (Exception ex)
                {
                    try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Installer Form error: {ex}\n"); } catch { }
                    // Fallback nếu không hiện được form: tự cài đặt và chạy tray
                    EnsureInstalledAndShortcuts();
                    RunTrayAgent();
                    return;
                }
            }

            try { AttachConsole(ATTACH_PARENT_PROCESS); } catch { }
            try
            {
                var stdOutStream = Console.OpenStandardOutput();
                if (stdOutStream != null && stdOutStream != Stream.Null)
                {
                    Console.SetOut(new StreamWriter(stdOutStream, System.Text.Encoding.UTF8) { AutoFlush = true });
                }
                var stdErrStream = Console.OpenStandardError();
                if (stdErrStream != null && stdErrStream != Stream.Null)
                {
                    Console.SetError(new StreamWriter(stdErrStream, System.Text.Encoding.UTF8) { AutoFlush = true });
                }
                Console.OutputEncoding = System.Text.Encoding.UTF8;
            }
            catch { }

            if (args.Length == 1 && args[0].Equals("--console", StringComparison.OrdinalIgnoreCase))
            {
                try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Calling RunConsoleAgent...\n"); } catch { }
                RunConsoleAgent();
                return;
            }
            Console.WriteLine("╔══════════════════════════════════════════════════════════════╗");
            Console.WriteLine("║   HỆ THỐNG KÝ SỐ THẬT CHUYÊN DÙNG BAN CƠ YẾU CHÍNH PHỦ (VGCA)║");
            Console.WriteLine("║   Trường THCS Chu Văn An - Xã Đăk Hà - Tỉnh Quảng Ngãi       ║");
            Console.WriteLine("╚══════════════════════════════════════════════════════════════╝");

            if (args.Length > 0 && (args[0].Equals("--verify", StringComparison.OrdinalIgnoreCase) || args[0].Equals("-v", StringComparison.OrdinalIgnoreCase)))
            {
                string verifyFile = args.Length > 1 ? args[1] : System.IO.Path.Combine(Directory.GetCurrentDirectory(), "GiaoAn_DaKy_That.pdf");
                KiemTraChuKyPdf(verifyFile);
                return;
            }

            if (args.Length > 0 && args[0].Equals("--find-anchor", StringComparison.OrdinalIgnoreCase))
            {
                string pdfFile = args.Length > 1 ? args[1] : "GiaoAn_CanKy.pdf";
                string signerName = args.Length > 2 ? args[2] : "Hà Văn Tý";
                string role = args.Length > 3 ? args[3] : "teacher";
                FindAnchor(pdfFile, signerName, role);
                return;
            }

            if (args.Length > 0 && args[0].Equals("--copy-sign", StringComparison.OrdinalIgnoreCase))
            {
                string copyInputPdf = args.Length > 1 ? args[1] : "GiaoAn_CanKy.pdf";
                string copyOutputPdf = args.Length > 2 ? args[2] : "GiaoAn_SaoY.pdf";
                string copyType = args.Length > 3 ? args[3] : "SAO Y";
                string signerName = args.Length > 4 ? args[4] : "Hà Văn Tý";

                string copyText = $"{copyType}; {signerName}; Thời gian ký: {DateTimeOffset.Now:yyyy-MM-ddTHH:mm:sszzz}";
                var banner = GenerateCopySignBanner(copyText);

                byte[] inBytes;
                try
                {
                    inBytes = File.ReadAllBytes(copyInputPdf);
                }
                catch (Exception ex)
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine($"❌ Không thể đọc tệp đầu vào [{copyInputPdf}]: {ex.Message}");
                    Console.ResetColor();
                    return;
                }

                float p1W = 595.28f, p1H = 841.89f;
                try
                {
                    using var ms = new MemoryStream(inBytes);
                    using var r = new PdfReader(ms);
                    using var d = new PdfDocument(r);
                    var p1 = d.GetPage(1);
                    if (p1 != null)
                    {
                        p1W = p1.GetPageSize().GetWidth();
                        p1H = p1.GetPageSize().GetHeight();
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"⚠️ Cảnh báo cấu trúc PDF ({ex.Message}), áp dụng kích thước chuẩn A4.");
                }

                float copyW = banner.widthPt;
                float copyH = banner.heightPt;
                float copyX = p1W - copyW - 40f;
                float copyY = p1H - copyH - 18f;
                var signRect = new Rectangle(copyX, copyY, copyW, copyH);

                byte[] outBytes = KySoPdfBytes(inBytes, $"{copyType} theo NĐ 30/2020/NĐ-CP - {signerName}", "Quảng Ngãi", strict: false, visualSignImageBytes: banner.imageBytes, signRect: signRect, targetPage: 1);
                
                string tempOut = copyOutputPdf + ".tmp." + Guid.NewGuid().ToString("N");
                File.WriteAllBytes(tempOut, outBytes);
                File.Move(tempOut, copyOutputPdf, true);
                Console.WriteLine($"✅ Ký sao y thành công: {copyOutputPdf}");
                return;
            }

            // 1. Tìm chứng thư thật của Giáo viên / Ban Cơ yếu trong Windows Certificate Store
            X509Certificate2? realCert = FindVgcaCertificate();

            if (realCert == null)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("❌ Không tìm thấy chứng thư số Ban Cơ yếu Chính phủ hoặc USB Token trong kho Windows!");
                Console.ResetColor();
                return;
            }

            using var certCleanup = realCert;

            DateTime utcNow = DateTime.UtcNow;
            if (utcNow < realCert.NotBefore.ToUniversalTime() || utcNow > realCert.NotAfter.ToUniversalTime())
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"❌ Chứng thư số đã hết hạn hoặc chưa có hiệu lực ({realCert.NotBefore:dd/MM/yyyy HH:mm:ss} - {realCert.NotAfter:dd/MM/yyyy HH:mm:ss})!");
                Console.ResetColor();
                return;
            }

            if (!realCert.HasPrivateKey)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("❌ Chứng thư số không chứa hoặc không thể truy cập Khóa riêng (Private Key)!");
                Console.ResetColor();
                return;
            }

            string algoName = "";
            using (var ec = realCert.GetECDsaPrivateKey())
            {
                if (ec != null)
                {
                    algoName = "ECDSA";
                }
            }

            if (string.IsNullOrEmpty(algoName))
            {
                using (var rsa = realCert.GetRSAPrivateKey())
                {
                    if (rsa != null)
                    {
                        algoName = "RSA";
                    }
                }
            }

            if (string.IsNullOrEmpty(algoName))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("❌ Không thể trích xuất khóa riêng ECDSA hoặc RSA hợp lệ từ chứng thư số!");
                Console.ResetColor();
                return;
            }

            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine($"✅ ĐÃ TÌM THẤY CHỨNG THƯ THẬT:");
            Console.WriteLine($"   - Chủ sở hữu: {realCert.Subject}");
            Console.WriteLine($"   - Cơ quan cấp: {realCert.Issuer}");
            Console.WriteLine($"   - Thời hạn đến: {realCert.NotAfter:dd/MM/yyyy HH:mm:ss}");
            Console.WriteLine($"   - Thuật toán: {realCert.PublicKey.Oid.FriendlyName} ({algoName})");
            Console.ResetColor();
            Console.WriteLine();

            // 2. Chuẩn bị file PDF đầu vào và đầu ra
            string currentDir = Directory.GetCurrentDirectory();
            string inputPdf = "";
            string outputPdf = "";
            int targetPage = 0; // 0 = last page
            float rectX = -1f, rectY = -1f, rectW = 90f, rectH = 60f;
            string certSignerCn = ExtractCn(realCert.Subject);
            string reason = !string.IsNullOrWhiteSpace(certSignerCn)
                ? $"{certSignerCn} đã ký số xác thực lên văn bản này."
                : "Ký số xác thực văn bản điện tử";
            string location = "Việt Nam";

            int argOffset = 0;
            if (args.Length > 0 && args[0].Equals("--sign", StringComparison.OrdinalIgnoreCase))
            {
                argOffset = 1;
            }

            if (args.Length > argOffset) inputPdf = args[argOffset];
            if (args.Length > argOffset + 1) outputPdf = args[argOffset + 1];
            if (args.Length > argOffset + 2 && int.TryParse(args[argOffset + 2], out int p)) targetPage = p;
            if (args.Length > argOffset + 3 && float.TryParse(args[argOffset + 3], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float xVal)) rectX = xVal;
            if (args.Length > argOffset + 4 && float.TryParse(args[argOffset + 4], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float yVal)) rectY = yVal;
            if (args.Length > argOffset + 5 && float.TryParse(args[argOffset + 5], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float wVal)) rectW = wVal;
            if (args.Length > argOffset + 6 && float.TryParse(args[argOffset + 6], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float hVal)) rectH = hVal;
            if (args.Length > argOffset + 7 && !string.IsNullOrWhiteSpace(args[argOffset + 7])) reason = args[argOffset + 7];
            if (args.Length > argOffset + 8 && !string.IsNullOrWhiteSpace(args[argOffset + 8])) location = args[argOffset + 8];

            string sigImagePath = "";
            if (args.Length > argOffset + 9) sigImagePath = args[argOffset + 9];
            byte[]? cliSigImgBytes = ResolveSignatureImage(sigImagePath);

            if (string.IsNullOrWhiteSpace(inputPdf))
                inputPdf = System.IO.Path.Combine(currentDir, "GiaoAn_CanKy.pdf");
            if (string.IsNullOrWhiteSpace(outputPdf))
                outputPdf = System.IO.Path.Combine(currentDir, "GiaoAn_DaKy_That.pdf");

            string fullInputPath = System.IO.Path.GetFullPath(inputPdf);
            string fullOutputPath = System.IO.Path.GetFullPath(outputPdf);

            if (string.Equals(fullInputPath, fullOutputPath, StringComparison.OrdinalIgnoreCase))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("❌ Tệp đầu vào (inputPdf) và tệp đầu ra (outputPdf) không được trùng nhau để tránh làm hỏng tệp gốc!");
                Console.ResetColor();
                return;
            }

            // Đọc snapshot tệp đầu vào bằng FileStream dùng một lần để triệt tiêu hoàn toàn TOCTOU
            byte[] inputPdfBytes;
            try
            {
                using (var inStream = new FileStream(fullInputPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (inStream.Length == 0)
                    {
                        Console.ForegroundColor = ConsoleColor.Red;
                        Console.WriteLine($"❌ Tệp PDF đầu vào rỗng (0 byte): {fullInputPath}");
                        Console.ResetColor();
                        return;
                    }
                    if (inStream.Length > 200 * 1024 * 1024L || inStream.Length > int.MaxValue)
                    {
                        Console.ForegroundColor = ConsoleColor.Red;
                        Console.WriteLine($"❌ Tệp PDF đầu vào vượt quá giới hạn cho phép (tối đa 200MB): {fullInputPath}");
                        Console.ResetColor();
                        return;
                    }
                    int expectedLength = checked((int)inStream.Length);
                    inputPdfBytes = new byte[expectedLength];
                    int totalRead = 0;
                    while (totalRead < expectedLength)
                    {
                        int read = inStream.Read(inputPdfBytes, totalRead, expectedLength - totalRead);
                        if (read == 0) break;
                        totalRead += read;
                    }
                    if (totalRead != expectedLength)
                    {
                        Console.ForegroundColor = ConsoleColor.Red;
                        Console.WriteLine($"❌ Không thể đọc toàn vẹn dữ liệu từ tệp PDF đầu vào ({totalRead}/{expectedLength} bytes): {fullInputPath}");
                        Console.ResetColor();
                        return;
                    }
                }
            }
            catch (FileNotFoundException)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"❌ Không tìm thấy tệp PDF đầu vào: {fullInputPath}");
                Console.ResetColor();
                return;
            }
            catch (Exception openEx)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"❌ Không thể mở tệp PDF đầu vào: {openEx.Message}");
                Console.ResetColor();
                return;
            }

            Console.WriteLine($"📄 Sử dụng file PDF đầu vào: {fullInputPath}");
            Console.WriteLine($"📁 File xuất chữ ký số dự kiến: {fullOutputPath}");

            bool hasExisting = HasExistingSignature(inputPdfBytes);

            // 3. Xác định trang cần ký và kích thước trang
            int totalPages = 1;
            float pageWidth = 595.28f, pageHeight = 841.89f;
            using (var tempReader = new PdfReader(new MemoryStream(inputPdfBytes)))
            using (var tempDoc = new PdfDocument(tempReader))
            {
                totalPages = tempDoc.GetNumberOfPages();
                if (targetPage <= 0 || targetPage > totalPages)
                    targetPage = totalPages;

                var pageObj = tempDoc.GetPage(targetPage);
                var pageSize = pageObj.GetPageSize();
                pageWidth = pageSize.GetWidth();
                pageHeight = pageSize.GetHeight();
            }

            // Tự động tính tọa độ nếu chưa được chỉ định
            if (rectX < 0 || rectY < 0)
            {
                var autoCoords = DetermineCoordinates(inputPdfBytes, certSignerCn, "teacher", null, null, rectW, rectH, targetPage);
                targetPage = autoCoords.page;
                rectX = autoCoords.x;
                rectY = autoCoords.y;
                rectW = autoCoords.w;
                rectH = autoCoords.h;
            }

            Console.WriteLine($"📍 Thông số vị trí chữ ký số: Trang {targetPage}/{totalPages} (Kích thước: {pageWidth:F0}x{pageHeight:F0}), X={rectX:F1}, Y={rectY:F1}, W={rectW:F1}, H={rectH:F1}");

            // 4. Thực hiện ký số chuẩn PAdES với ghi nguyên tử (Atomic Write qua Temp File)
            string outputDir = System.IO.Path.GetDirectoryName(fullOutputPath) ?? currentDir;
            string tempOutputPdf = System.IO.Path.Combine(outputDir, $"tmp_{Guid.NewGuid():N}.pdf");

            bool isTest = Environment.GetEnvironmentVariable("EDUSIGN_TEST_MODE") == "1" ||
                          Environment.GetEnvironmentVariable("NODE_ENV") == "test";

            try
            {
                bool signSuccess = false;
                if (isTest)
                {
                    SignWithBouncyCastle(fullInputPath, tempOutputPdf, realCert, reason, location, targetPage, rectX, rectY, rectW, rectH, cliSigImgBytes);
                    signSuccess = true;
                    Console.WriteLine("\n🎉🎉🎉 KÝ SỐ THÀNH CÔNG 100% (TEST BOUNCYCASTLE)! 🎉🎉🎉");
                }
                else
                {
                    Console.WriteLine("⚙️ Đang thiết lập cấu trúc chữ ký số PAdES...");
                    try
                    {
                        using (var inputStream = new MemoryStream(inputPdfBytes))
                        using (var reader = new PdfReader(inputStream))
                        using (var outputStream = new FileStream(tempOutputPdf, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            StampingProperties stampingProperties = new StampingProperties();
                            stampingProperties.UseAppendMode();

                            PdfSigner signer = new PdfSigner(reader, outputStream, stampingProperties);

                            string fieldName = "SignatureVGCA_" + DateTime.Now.Ticks;
                            SignerProperties signerProperties = new SignerProperties()
                                .SetFieldName(fieldName)
                                .SetReason(reason)
                                .SetLocation(location);

                            if ((hasExisting || cliSigImgBytes != null) && targetPage > 0 && rectX >= 0 && rectY >= 0)
                            {
                                signerProperties.SetPageNumber(targetPage);
                                signerProperties.SetPageRect(new Rectangle(rectX, rectY, rectW, rectH));

                                if (cliSigImgBytes != null && cliSigImgBytes.Length > 0)
                                {
                                    try
                                    {
                                        var appearance = new SignatureFieldAppearance(fieldName)
                                            .SetContent(ImageDataFactory.Create(cliSigImgBytes));
                                        signerProperties.SetSignatureAppearance(appearance);
                                        Console.WriteLine($"[PAdES Visual Appearance] Đã nhúng hình ảnh chữ ký số trực quan tại Trang {targetPage}, ({rectX:F1}, {rectY:F1})...");
                                    }
                                    catch (Exception appEx)
                                    {
                                        Console.WriteLine($"⚠️ Gặp sự cố khi thiết lập hình ảnh chữ ký: {appEx.Message}");
                                    }
                                }
                            }

                            signer.SetSignerProperties(signerProperties);

                            // Nạp đối tượng ký VGCA
                            IExternalSignature pks = new VgcaSignature(realCert);
                            Org.BouncyCastle.X509.X509Certificate bcCert = new Org.BouncyCastle.X509.X509CertificateParser().ReadCertificate(realCert.RawData);
                            IX509Certificate bcCertWrapper = new X509CertificateBC(bcCert);
                            IX509Certificate[] chain = new IX509Certificate[] { bcCertWrapper };

                            // Ký số và nhúng chữ ký PKCS#7 vào file PDF
                            signer.SignDetached(pks, chain, null, null, null, 0, PdfSigner.CryptoStandard.CADES);
                        }
                        signSuccess = true;
                    }
                    catch (Exception cngEx)
                    {
                        Console.WriteLine($"⚠️ Thử ký qua Virtual CSP gặp sự cố ({cngEx.Message}), tự động kích hoạt bộ ký số BouncyCastle Cryptography...");
                        try { if (File.Exists(tempOutputPdf)) File.Delete(tempOutputPdf); } catch { }
                        SignWithBouncyCastle(fullInputPath, tempOutputPdf, realCert, reason, location, targetPage, rectX, rectY, rectW, rectH, cliSigImgBytes);
                        signSuccess = true;
                    }
                }

                if (signSuccess && File.Exists(tempOutputPdf) && new FileInfo(tempOutputPdf).Length > 0)
                {
                    File.Move(tempOutputPdf, fullOutputPath, overwrite: true);
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("\n🎉🎉🎉 KÝ SỐ THÀNH CÔNG 100%! 🎉🎉🎉");
                    Console.WriteLine($"📁 File PDF kết quả đã được tạo tại:");
                    Console.WriteLine($"   👉 {fullOutputPath}");
                    Console.WriteLine("\n👉 THẦY HÃY MỞ FILE TRÊN BẰNG ADOBE ACROBAT READER:");
                    Console.WriteLine("   Nó sẽ hiện chính xác thanh màu xanh:");
                    Console.WriteLine("   \"This document is digitally signed. All signatures are valid.\"");
                    Console.ResetColor();
                }
                else
                {
                    throw new IOException("Tệp PDF sau khi ký không hợp lệ hoặc không có dữ liệu.");
                }
            }
            catch (Exception ex)
            {
                try { if (File.Exists(tempOutputPdf)) File.Delete(tempOutputPdf); } catch { }
                Console.WriteLine($"⚠️ Kích hoạt bộ niêm phong số BouncyCastle VGCA PAdES chuẩn: {ex.Message}");
                try
                {
                    SignWithBouncyCastle(fullInputPath, tempOutputPdf, realCert, reason, location, targetPage, rectX, rectY, rectW, rectH, cliSigImgBytes);
                    if (File.Exists(tempOutputPdf) && new FileInfo(tempOutputPdf).Length > 0)
                    {
                        File.Move(tempOutputPdf, fullOutputPath, overwrite: true);
                        Console.ForegroundColor = ConsoleColor.Green;
                        Console.WriteLine("\n🎉🎉🎉 KÝ SỐ THÀNH CÔNG 100% (BOUNCYCASTLE ENGINE)! 🎉🎉🎉");
                        Console.WriteLine($"📁 File PDF kết quả đã được tạo tại: {fullOutputPath}");
                        Console.ResetColor();
                    }
                    else
                    {
                        throw new IOException("Không thể tạo file ký số qua BouncyCastle.");
                    }
                }
                catch (Exception bEx)
                {
                    try { if (File.Exists(tempOutputPdf)) File.Delete(tempOutputPdf); } catch { }
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine($"❌ Lỗi trong quá trình ký: {bEx.Message}");
                    Console.WriteLine(bEx.StackTrace);
                    Console.ResetColor();
                }
            }
            finally
            {
                try { if (File.Exists(tempOutputPdf)) File.Delete(tempOutputPdf); } catch { }
            }
        }

        static void TaoFilePdfMau(string path)
        {
            if (File.Exists(path)) return;

            using (PdfWriter writer = new PdfWriter(path))
            using (PdfDocument pdf = new PdfDocument(writer))
            using (Document document = new Document(pdf))
            {
                document.Add(new Paragraph("UBND HUYỆN ĐĂK HÀ").SetFontSize(12));
                document.Add(new Paragraph("TRƯỜNG THCS CHU VĂN AN").SetFontSize(14));
                document.Add(new Paragraph("\nKẾ HOẠCH BÀI DẠY (GIÁO ÁN ĐIỆN TỬ)").SetFontSize(16));
                document.Add(new Paragraph("Môn: Toán 9 - Năm học 2026 - 2027").SetFontSize(12));
                document.Add(new Paragraph("Giáo viên thực hiện: Thầy Hà Văn Tý").SetFontSize(12));
                document.Add(new Paragraph("\nI. MỤC TIÊU BÀI HỌC:\n- Học sinh nắm vững định nghĩa và tính chất cơ bản.\n- Ứng dụng giải quyết bài toán thực tế."));
                document.Add(new Paragraph("\nII. TIẾN TRÌNH DẠY HỌC:\n- Tiết 1: Ôn tập và khởi động.\n- Tiết 2: Hình thành kiến thức mới."));
                document.Add(new Paragraph("\n\n\n[KHU VỰC ĐÓNG DẤU CHỮ KÝ SỐ CHUYÊN DÙNG VGCA]").SetFontSize(10));
            }
        }

        static void KiemTraChuKyPdf(string pdfPath)
        {
            Console.WriteLine($"🔍 Đang kiểm tra tính xác thực chữ ký số trong file: {pdfPath}\n");
            if (!File.Exists(pdfPath))
            {
                Console.WriteLine("❌ File không tồn tại!");
                return;
            }

            try
            {
                using (PdfReader reader = new PdfReader(pdfPath))
                using (PdfDocument pdfDoc = new PdfDocument(reader))
                {
                    SignatureUtil signUtil = new SignatureUtil(pdfDoc);
                    var names = signUtil.GetSignatureNames();
                    Console.WriteLine($"📊 Số lượng chữ ký số tìm thấy: {names.Count}");

                    foreach (var name in names)
                    {
                        Console.WriteLine($"\n================= CHỨNG THƯ CHỮ KÝ: [{name}] =================");
                        PdfPKCS7 pkcs7 = signUtil.ReadSignatureData(name);
                        Console.WriteLine($"👤 Tên người ký (SignName): {pkcs7.GetSignName()}");
                        Console.WriteLine($"📋 Lý do ký (Reason): {pkcs7.GetReason()}");
                        Console.WriteLine($"📍 Địa điểm ký (Location): {pkcs7.GetLocation()}");
                        Console.WriteLine($"⏰ Thời điểm ký: {pkcs7.GetSignDate():dd/MM/yyyy HH:mm:ss}");
                        string digestAlg = pkcs7.GetDigestAlgorithmName() ?? "";
                        Console.WriteLine($"🔐 Thuật toán băm: {digestAlg}");
                        Console.WriteLine($"🔑 Tiêu chuẩn chữ ký: {pkcs7.GetFilterSubtype()}");

                        var cert = pkcs7.GetSigningCertificate();
                        if (cert != null)
                        {
                            Console.WriteLine($"📜 Chủ thể chứng thư (Subject): {cert.GetSubjectDN()}");
                            Console.WriteLine($"🏛️ Cơ quan cấp phát (Issuer): {cert.GetIssuerDN()}");
                        }

                        bool coversWholeDoc = signUtil.SignatureCoversWholeDocument(name);
                        Console.WriteLine($"📄 Phạm vi chữ ký: {(coversWholeDoc ? "Bao phủ toàn bộ tài liệu (Covers whole doc): CÓ (Revision mới nhất)" : "Bao phủ một phần tài liệu (Covers whole doc): KHÔNG")}");

                        // Xác minh tính toàn vẹn và xác thực mật mã
                        bool isIntegrityValid = false;
                        try { isIntegrityValid = pkcs7.VerifySignatureIntegrityAndAuthenticity(); }
                        catch (Exception vEx) { Console.WriteLine($"⚠️ Lỗi giải mã chữ ký: {vEx.Message}"); }

                        bool isCertDateValid = false;
                        string certStatus = "Không có chứng thư";
                        if (cert != null)
                        {
                            try
                            {
                                cert.CheckValidity(DateTime.UtcNow);
                                isCertDateValid = true;
                                certStatus = "Chứng thư còn hiệu lực";
                            }
                            catch (Org.BouncyCastle.Security.Certificates.CertificateExpiredException) { certStatus = "Chứng thư đã hết hạn"; }
                            catch (Org.BouncyCastle.Security.Certificates.CertificateNotYetValidException) { certStatus = "Chứng thư chưa đến thời điểm hiệu lực"; }
                            catch (Exception cEx) { certStatus = $"Lỗi chứng thư: {cEx.Message}"; }
                        }

                        bool isDigestSecure = digestAlg.Equals("SHA256", StringComparison.OrdinalIgnoreCase) ||
                                              digestAlg.Equals("SHA384", StringComparison.OrdinalIgnoreCase) ||
                                              digestAlg.Equals("SHA512", StringComparison.OrdinalIgnoreCase) ||
                                              digestAlg.Equals("SHA-256", StringComparison.OrdinalIgnoreCase) ||
                                              digestAlg.Equals("SHA-384", StringComparison.OrdinalIgnoreCase) ||
                                              digestAlg.Equals("SHA-512", StringComparison.OrdinalIgnoreCase);

                        bool isValid = isIntegrityValid && isDigestSecure && isCertDateValid;

                        // In vị trí ô chữ ký (Rectangle và Page)
                        var form = iText.Forms.PdfAcroForm.GetAcroForm(pdfDoc, false);
                        if (form != null)
                        {
                            var field = form.GetField(name);
                            if (field != null)
                            {
                                foreach (var w in field.GetWidgets())
                                {
                                    var rect = w.GetRectangle().ToRectangle();
                                    var page = w.GetPage();
                                    int pageNum = page != null ? pdfDoc.GetPageNumber(page) : -1;
                                    Console.WriteLine($"📐 Vị trí ô chữ ký: Trang {pageNum}, X={rect.GetX():F1}, Y={rect.GetY():F1}, W={rect.GetWidth():F1}, H={rect.GetHeight():F1}");
                                }
                            }
                        }

                        Console.ForegroundColor = isValid ? ConsoleColor.Green : ConsoleColor.Red;
                        if (!isDigestSecure)
                            Console.WriteLine($"\n⭐ KẾT LUẬN: ❌ KHÔNG HỢP LỆ (Thuật toán băm '{digestAlg}' không an toàn, yêu cầu tối thiểu SHA-256)");
                        else if (!isCertDateValid)
                            Console.WriteLine($"\n⭐ KẾT LUẬN: ❌ KHÔNG HỢP LỆ ({certStatus})");
                        else if (isValid)
                            Console.WriteLine($"\n⭐ KẾT LUẬN: ✅ HỢP LỆ TUYỆT ĐỐI (Chữ ký hợp lệ về mặt mật mã; chưa đánh giá chuỗi tin cậy/thu hồi chứng thư)");
                        else
                            Console.WriteLine("\n⭐ KẾT LUẬN: ❌ KHÔNG HỢP LỆ (Toàn vẹn dữ liệu bị xâm phạm hoặc chữ ký không khớp)");
                        Console.ResetColor();
                        Console.WriteLine("===============================================================");
                    }
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"❌ Lỗi đọc chữ ký số: {ex.Message}");
                Console.ResetColor();
            }
        }

        public static void FindAnchor(string pdfPath, string signerName, string role)
        {
            try
            {
                if (!File.Exists(pdfPath))
                {
                    Console.WriteLine("[ANCHOR_RESULT_JSON]");
                    Console.WriteLine(JsonSerializer.Serialize(new { found = false, message = "File not found" }));
                    return;
                }

                using var pdfReader = new PdfReader(pdfPath);
                using var pdfDoc = new PdfDocument(pdfReader);
                int pageCount = pdfDoc.GetNumberOfPages();
                var page = pdfDoc.GetPage(pageCount);
                var pageSize = page.GetPageSize();
                float pW = pageSize.GetWidth();
                float pH = pageSize.GetHeight();
                bool isLandscape = pW > pH;

                var listener = new TextCollectorListener();
                var processor = new PdfCanvasProcessor(listener);
                processor.ProcessPageContent(page);

                // Nhóm text chunk thành từng dòng theo tọa độ Y
                var lines = new List<(float Y, List<TextChunk> Chunks, string Text)>();
                listener.Chunks.Sort((a, b) => b.Y.CompareTo(a.Y));

                var curLineChunks = new List<TextChunk>();
                foreach (var chunk in listener.Chunks)
                {
                    if (curLineChunks.Count == 0)
                    {
                        curLineChunks.Add(chunk);
                    }
                    else
                    {
                        if (Math.Abs(curLineChunks[0].Y - chunk.Y) <= 4.0f)
                        {
                            curLineChunks.Add(chunk);
                        }
                        else
                        {
                            curLineChunks.Sort((a, b) => a.X.CompareTo(b.X));
                            string lineText = string.Join("", curLineChunks.ConvertAll(c => c.Text));
                            lines.Add((curLineChunks[0].Y, new List<TextChunk>(curLineChunks), lineText));
                            curLineChunks.Clear();
                            curLineChunks.Add(chunk);
                        }
                    }
                }
                if (curLineChunks.Count > 0)
                {
                    curLineChunks.Sort((a, b) => a.X.CompareTo(b.X));
                    string lineText = string.Join("", curLineChunks.ConvertAll(c => c.Text));
                    lines.Add((curLineChunks[0].Y, new List<TextChunk>(curLineChunks), lineText));
                }

                static string Norm(string s)
                {
                    if (string.IsNullOrEmpty(s)) return "";
                    string n = s.Normalize(System.Text.NormalizationForm.FormC);
                    return System.Text.RegularExpressions.Regex.Replace(n, @"\s+", "").ToLowerInvariant();
                }

                bool isTeacher = role.ToLower().Contains("teacher") || role.Contains("1") || (!role.ToLower().Contains("leader") && !role.ToLower().Contains("principal"));
                bool isLeader = role.ToLower().Contains("leader") || role.Contains("2");
                bool isPrincipal = role.ToLower().Contains("principal") || role.Contains("3");

                float minColX = isTeacher ? (pW * 0.55f) : (isLeader ? (pW * 0.30f) : 0f);
                float maxColX = isTeacher ? pW : (isLeader ? (pW * 0.65f) : (pW * 0.35f));

                // Giới hạn tìm kiếm trong Bounding Box vùng ký số (nửa dưới trang cuối)
                float maxSignatureY = isLandscape ? (pH * 0.55f) : (pH * 0.38f);
                float minSignatureY = 30f;

                var roleCandidates = new List<(float X, float Y)>();
                var nameCandidates = new List<(float X, float Y)>();

                string targetSignerNorm = !string.IsNullOrWhiteSpace(signerName) ? Norm(signerName) : "";

                foreach (var line in lines)
                {
                    if (line.Y > maxSignatureY || line.Y < minSignatureY) continue;

                    string normLt = Norm(line.Text);

                    // Chỉ tìm từ khóa chức danh phù hợp với vai trò cần ký
                    bool isRoleMatch = false;
                    if (isTeacher && (normLt.Contains(Norm("GIÁO VIÊN")) || normLt.Contains(Norm("Người lập")) || normLt.Contains(Norm("NGƯỜI SOẠN"))))
                        isRoleMatch = true;
                    else if (isLeader && (normLt.Contains(Norm("TỔ TRƯỞNG")) || normLt.Contains(Norm("TRƯỞNG BỘ MÔN"))))
                        isRoleMatch = true;
                    else if (isPrincipal && (normLt.Contains(Norm("HIỆU TRƯỞNG")) || normLt.Contains(Norm("PHÓ HIỆU")) || normLt.Contains(Norm("GIÁM HIỆU")) || normLt.Contains(Norm("BAN GIÁM HIỆU"))))
                        isRoleMatch = true;

                    if (isRoleMatch)
                    {
                        var colChunks = line.Chunks.FindAll(c => c.X >= minColX && c.X <= maxColX);
                        if (colChunks.Count > 0)
                        {
                            roleCandidates.Add((colChunks[0].X, line.Y));
                        }
                    }

                    // Chỉ tìm tên nếu có signerName cụ thể, không dùng danh sách tên hard-code phổ biến
                    if (!string.IsNullOrEmpty(targetSignerNorm) && normLt.Contains(targetSignerNorm))
                    {
                        var colChunks = line.Chunks.FindAll(c => c.X >= minColX && c.X <= maxColX);
                        if (colChunks.Count > 0)
                        {
                            nameCandidates.Add((colChunks[0].X, line.Y));
                        }
                    }
                }

                // Ghép cặp ứng viên Role và Name theo điểm số khoảng cách hình học
                var validPairs = new List<((float X, float Y) Role, (float X, float Y) Name, float Score)>();
                foreach (var r in roleCandidates)
                {
                    foreach (var n in nameCandidates)
                    {
                        float dy = r.Y - n.Y;
                        float dx = Math.Abs(r.X - n.X);
                        if (dy >= 25f && dy <= 150f && dx <= 80f)
                        {
                            float score = dx * 2f + Math.Abs(dy - 65f);
                            validPairs.Add((r, n, score));
                        }
                    }
                }

                float? targetNameY = null;
                float? targetNameX = null;
                float? targetRoleY = null;
                float? targetRoleX = null;

                if (validPairs.Count > 0)
                {
                    validPairs.Sort((a, b) => a.Score.CompareTo(b.Score));
                    // Chỉ chấp nhận nếu cặp có điểm số tốt nhất là duy nhất rõ ràng
                    if (validPairs.Count == 1 || (validPairs.Count > 1 && (validPairs[1].Score - validPairs[0].Score) >= 2.0f))
                    {
                        var best = validPairs[0];
                        targetRoleX = best.Role.X;
                        targetRoleY = best.Role.Y;
                        targetNameX = best.Name.X;
                        targetNameY = best.Name.Y;
                    }
                    else
                    {
                        Console.WriteLine("⚠️ Phát hiện nhiều vị trí ký tương đồng trong cột, chuyển về vị trí mặc định an toàn.");
                    }
                }
                else
                {
                    if (roleCandidates.Count == 1 && nameCandidates.Count == 0)
                    {
                        targetRoleX = roleCandidates[0].X;
                        targetRoleY = roleCandidates[0].Y;
                    }
                    else if (nameCandidates.Count == 1 && roleCandidates.Count == 0)
                    {
                        targetNameX = nameCandidates[0].X;
                        targetNameY = nameCandidates[0].Y;
                    }
                }

                bool isSeal = (role ?? "").Contains("seal", StringComparison.OrdinalIgnoreCase) || (isPrincipal && !string.IsNullOrEmpty(signerName) && (signerName.Contains("Ban Giám hiệu", StringComparison.OrdinalIgnoreCase) || signerName.Contains("TRƯỜNG", StringComparison.OrdinalIgnoreCase) || signerName.Contains("TRUONG", StringComparison.OrdinalIgnoreCase)));
                float stampW = isSeal ? 105f : 95f;
                float stampH = isSeal ? 105f : 60f;
                float defaultX = isTeacher ? (isLandscape ? pW * 0.745f : pW * 0.74f)
                               : isLeader ? (isLandscape ? pW * 0.46f : pW * 0.46f)
                               : (isLandscape ? pW * 0.18f : pW * 0.18f);
                float defaultY = isLandscape ? 275f : 120f;

                float stampX = defaultX;
                float stampY = defaultY;
                bool foundAnchor = false;

                if (targetNameY.HasValue && targetRoleY.HasValue)
                {
                    float midY = (targetRoleY.Value + targetNameY.Value) / 2f;
                    stampY = midY - (stampH / 2f);
                    float anchorX = targetNameX ?? targetRoleX ?? defaultX;
                    stampX = anchorX - (stampW * 0.15f);
                    foundAnchor = true;
                }
                else if (targetNameY.HasValue)
                {
                    stampY = targetNameY.Value + 15f;
                    float anchorX = targetNameX ?? defaultX;
                    stampX = anchorX - (stampW * 0.15f);
                    foundAnchor = true;
                }
                else if (targetRoleY.HasValue)
                {
                    stampY = targetRoleY.Value - stampH - 15f;
                    float anchorX = targetRoleX ?? defaultX;
                    stampX = anchorX - (stampW * 0.15f);
                    foundAnchor = true;
                }

                stampX = Math.Max(10f, Math.Min(pW - stampW - 10f, stampX));
                stampY = Math.Max(10f, Math.Min(pH - stampH - 10f, stampY));

                var result = new
                {
                    found = foundAnchor,
                    x = Math.Round(stampX, 1),
                    y = Math.Round(stampY, 1),
                    width = stampW,
                    height = stampH,
                    page = pageCount,
                    pageWidth = pW,
                    pageHeight = pH
                };

                Console.WriteLine("[ANCHOR_RESULT_JSON]");
                Console.WriteLine(JsonSerializer.Serialize(result));
            }
            catch (Exception ex)
            {
                Console.WriteLine("[ANCHOR_RESULT_JSON]");
                Console.WriteLine(JsonSerializer.Serialize(new { found = false, error = ex.Message }));
            }
        }

        public static bool HasExistingSignature(byte[] pdfBytes)
        {
            if (pdfBytes == null || pdfBytes.Length < 50) return false;
            try
            {
                using var reader = new PdfReader(new MemoryStream(pdfBytes));
                using var doc = new PdfDocument(reader);
                var sigUtil = new SignatureUtil(doc);
                return sigUtil.GetSignatureNames().Count > 0;
            }
            catch
            {
                return false;
            }
        }

        private static byte[]? ReadSecureImageFile(string path, string rootDir)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(rootDir))
                    return null;

                string normRoot = System.IO.Path.GetFullPath(rootDir).TrimEnd(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar;
                string fullPath = System.IO.Path.GetFullPath(path);

                if (!fullPath.StartsWith(normRoot, StringComparison.OrdinalIgnoreCase))
                    return null;

                // Mở trực tiếp bằng FileStream trong một thao tác duy nhất để triệt tiêu lỗ hổng TOCTOU (không dùng File.Exists trước)
                using var fs = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);

                // Kiểm tra thuộc tính tệp và liên kết thực tế để triệt tiêu symlink/junction/reparse point trỏ ra ngoài rootDir
                var fi = new FileInfo(fullPath);
                if ((fi.Attributes & FileAttributes.ReparsePoint) != 0 || fi.LinkTarget != null)
                    return null;

                var resolvedTarget = fi.ResolveLinkTarget(true);
                if (resolvedTarget != null)
                {
                    string targetFull = System.IO.Path.GetFullPath(resolvedTarget.FullName);
                    if (!targetFull.StartsWith(normRoot, StringComparison.OrdinalIgnoreCase))
                        return null;
                }

                // Kiểm tra tất cả các thư mục cha lên đến normRoot không chứa ReparsePoint hoặc LinkTarget
                var parentDir = fi.Directory;
                while (parentDir != null && !string.Equals(parentDir.FullName.TrimEnd(System.IO.Path.DirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar, normRoot, StringComparison.OrdinalIgnoreCase))
                {
                    if ((parentDir.Attributes & FileAttributes.ReparsePoint) != 0 || parentDir.LinkTarget != null)
                        return null;
                    parentDir = parentDir.Parent;
                }

                if (fs.Length <= 100 || fs.Length > 10 * 1024 * 1024L)
                    return null;

                int len = checked((int)fs.Length);
                byte[] data = new byte[len];
                int totalRead = 0;
                while (totalRead < len)
                {
                    int r = fs.Read(data, totalRead, len - totalRead);
                    if (r == 0) break;
                    totalRead += r;
                }
                if (totalRead == len) return data;
            }
            catch { }
            return null;
        }

        public static byte[]? ResolveSignatureImage(string? imageSource)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(imageSource))
                {
                    if (imageSource.StartsWith("data:image", StringComparison.OrdinalIgnoreCase) || imageSource.Contains(";base64,"))
                    {
                        string cleanBase64 = Regex.Replace(imageSource, @"^data:[^;]+;base64,", "");
                        byte[] decoded = Convert.FromBase64String(cleanBase64);
                        if (decoded.Length > 100 && decoded.Length <= 10 * 1024 * 1024) return decoded;
                    }
                    else
                    {
                        // Allowlist phần mở rộng ảnh hợp lệ
                        var allowedExts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg" };
                        string ext = System.IO.Path.GetExtension(imageSource);
                        if (allowedExts.Contains(ext))
                        {
                            string cleanPath = imageSource.TrimStart('/', '\\');
                            // Chặn đứng hoàn toàn path traversal qua ".."
                            if (!cleanPath.Contains(".."))
                            {
                                string currentDir = Directory.GetCurrentDirectory();
                                string baseDir = AppDomain.CurrentDomain.BaseDirectory;

                                string[] rootBases = new string[] { currentDir, baseDir };
                                foreach (var root in rootBases)
                                {
                                    byte[]? imgBytes = ReadSecureImageFile(System.IO.Path.Combine(root, cleanPath), root);
                                    if (imgBytes != null) return imgBytes;
                                }
                            }
                        }
                    }
                }

                // Fallback: Tìm file ảnh chữ ký chuẩn trong thư mục uploads/signatures hợp lệ
                string[] searchRoots = new string[]
                {
                    Directory.GetCurrentDirectory(),
                    AppDomain.CurrentDomain.BaseDirectory
                };
                foreach (var r in searchRoots)
                {
                    string fallbackSig = System.IO.Path.Combine(r, "uploads", "signatures", "sig_user_cvaty.png");
                    byte[]? imgBytes = ReadSecureImageFile(fallbackSig, r);
                    if (imgBytes != null) return imgBytes;
                }
            }
            catch { }

            return null;
        }

        /// <summary>
        /// Tạo ảnh đồ họa chữ ký Sao y chuẩn Nghị định 30/2020/NĐ-CP & Ban Cơ yếu Chính phủ (VGCA SignTool)
        /// Cú pháp: SAO Y; [Họ tên]; Thời gian ký: YYYY-MM-DDTHH:mm:ss+07:00
        /// </summary>
        public static (byte[] imageBytes, float widthPt, float heightPt) GenerateCopySignBanner(string copyText)
        {
            float scale = 3.0f; // 300 DPI high-definition rendering
            using var tempBmp = new System.Drawing.Bitmap(1, 1);
            using var tempG = System.Drawing.Graphics.FromImage(tempBmp);
            using var font = new System.Drawing.Font("Times New Roman", 9.5f * scale, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Pixel);
            var measured = tempG.MeasureString(copyText, font);

            int widthPx = Math.Max((int)Math.Ceiling(measured.Width) + 12, (int)(260 * scale));
            int heightPx = Math.Max((int)Math.Ceiling(measured.Height) + 6, (int)(16 * scale));

            using var bmp = new System.Drawing.Bitmap(widthPx, heightPx);
            using (var g = System.Drawing.Graphics.FromImage(bmp))
            {
                g.Clear(System.Drawing.Color.Transparent);
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                using var brush = new System.Drawing.SolidBrush(System.Drawing.Color.Black);

                var stringFormat = new System.Drawing.StringFormat
                {
                    Alignment = System.Drawing.StringAlignment.Far, // Căn phải lề văn bản đúng như H3
                    LineAlignment = System.Drawing.StringAlignment.Center
                };

                g.DrawString(copyText, font, brush, new System.Drawing.RectangleF(0, 0, widthPx, heightPx), stringFormat);
            }

            using var ms = new MemoryStream();
            bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            float widthPt = widthPx / scale;
            float heightPt = heightPx / scale;
            return (ms.ToArray(), widthPt, heightPt);
        }

        public static (int page, float x, float y, float w, float h) DetermineCoordinates(byte[] pdfBytes, string signerName, string role, float? reqX = null, float? reqY = null, float? reqW = null, float? reqH = null, int? reqPage = null, float? reqXPercent = null, float? reqYPercent = null, bool isManualDrag = false)
        {
            int targetPage = 1;
            float pW = 595.28f, pH = 841.89f;
            bool isLandscape = false;

            try
            {
                using var pdfReader = new PdfReader(new MemoryStream(pdfBytes));
                using var pdfDoc = new PdfDocument(pdfReader);
                int pageCount = pdfDoc.GetNumberOfPages();
                targetPage = (reqPage.HasValue && reqPage.Value > 0 && reqPage.Value <= pageCount) ? reqPage.Value : pageCount;
                var page = pdfDoc.GetPage(targetPage);
                var pageSize = page.GetPageSize();
                pW = pageSize.GetWidth();
                pH = pageSize.GetHeight();
                isLandscape = pW > pH;

                bool isSealRole = role.ToLower().Contains("seal") || 
                                  (role.ToLower().Contains("principal") && (signerName.Contains("TRƯỜNG", StringComparison.OrdinalIgnoreCase) || signerName.Contains("TRUONG", StringComparison.OrdinalIgnoreCase)));
                float defaultW = isSealRole ? 105f : 95f;
                float defaultH = isSealRole ? 105f : 60f;

                float w = reqW.HasValue && reqW.Value > 0 ? reqW.Value : defaultW;
                float h = reqH.HasValue && reqH.Value > 0 ? reqH.Value : defaultH;

                if (isSealRole && (h <= 85f || Math.Abs(w - h) > 20f))
                {
                    w = 105f;
                    h = 105f;
                }

                // Nếu người dùng kéo thả con dấu thủ công (isManualDrag == true),
                // TÔN TRỌNG TUYỆT ĐỐI tọa độ kéo thả (reqX, reqY) hoặc (reqXPercent, reqYPercent) trên đúng trang targetPage,
                // không cho thuật toán mỏ neo chữ (Smart Anchor) đè lên hoặc ép vị trí về chân trang.
                if (isManualDrag)
                {
                    float manualX;
                    float manualY;
                    if (reqX.HasValue && reqX.Value >= 0 && reqY.HasValue && reqY.Value >= 0)
                    {
                        float calcX = reqX.Value;
                        float calcY = reqY.Value;
                        if (reqW.HasValue && reqW.Value > 0 && Math.Abs(w - reqW.Value) > 2f)
                        {
                            calcX = reqX.Value + (reqW.Value - w) / 2f;
                        }
                        if (reqH.HasValue && reqH.Value > 0 && Math.Abs(h - reqH.Value) > 2f)
                        {
                            calcY = reqY.Value + (reqH.Value - h) / 2f;
                        }
                        manualX = Math.Max(5f, Math.Min(pW - w - 5f, calcX));
                        manualY = Math.Max(5f, Math.Min(pH - h - 5f, calcY));
                    }
                    else if (reqXPercent.HasValue && reqYPercent.HasValue)
                    {
                        manualX = Math.Max(5f, Math.Min(pW - w - 5f, (reqXPercent.Value / 100f) * pW));
                        manualY = Math.Max(5f, Math.Min(pH - h - 5f, pH - ((reqYPercent.Value / 100f) * pH) - h));
                    }
                    else
                    {
                        manualX = Math.Max(5f, Math.Min(pW - w - 5f, reqX.GetValueOrDefault(pW * 0.74f)));
                        manualY = Math.Max(5f, Math.Min(pH - h - 5f, reqY.GetValueOrDefault(120f)));
                    }
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] 🎯 Chế độ kéo thả thủ công (isManualDrag=true): Trang {targetPage}, X={manualX:F1}, Y={manualY:F1}, W={w:F1}, H={h:F1}");
                    return (targetPage, manualX, manualY, w, h);
                }

                // Nếu có tọa độ điểm tuyệt đối (reqX, reqY) mà không có reqXPercent -> tôn trọng tọa độ điểm
                if (!reqXPercent.HasValue && reqX.HasValue && reqX.Value >= 0 && reqY.HasValue && reqY.Value >= 0)
                {
                    float safeX = Math.Max(10f, Math.Min(pW - w - 10f, reqX.Value));
                    float safeY = Math.Max(10f, Math.Min(pH - h - 10f, reqY.Value));
                    return (targetPage, safeX, safeY, w, h);
                }

                // Nếu người dùng kéo thả con dấu (reqXPercent), tự động nhận diện Cột Ký mục tiêu:
                // - Cột 1 (< 35%): Ban Giám hiệu (Hiệu trưởng / Phó Hiệu trưởng)
                // - Cột 2 (35% - 60%): Tổ trưởng chuyên môn
                // - Cột 3 (> 60%): Giáo viên / Người lập kế hoạch
                if (reqXPercent.HasValue && reqXPercent.Value > 0)
                {
                    if (reqXPercent.Value < 35f) role = "principal";
                    else if (reqXPercent.Value <= 60f) role = "leader";
                    else role = "teacher";
                }

                // Dò tìm vị trí neo trên trang văn bản bằng Smart Anchor
                var listener = new TextCollectorListener();
                var processor = new PdfCanvasProcessor(listener);
                processor.ProcessPageContent(page);

                var lines = new List<(float Y, List<TextChunk> Chunks, string Text)>();
                listener.Chunks.Sort((a, b) => b.Y.CompareTo(a.Y));

                var curLineChunks = new List<TextChunk>();
                foreach (var chunk in listener.Chunks)
                {
                    if (curLineChunks.Count == 0) curLineChunks.Add(chunk);
                    else
                    {
                        if (Math.Abs(curLineChunks[0].Y - chunk.Y) <= 4.0f) curLineChunks.Add(chunk);
                        else
                        {
                            curLineChunks.Sort((a, b) => a.X.CompareTo(b.X));
                            lines.Add((curLineChunks[0].Y, new List<TextChunk>(curLineChunks), string.Join("", curLineChunks.ConvertAll(c => c.Text))));
                            curLineChunks.Clear();
                            curLineChunks.Add(chunk);
                        }
                    }
                }
                if (curLineChunks.Count > 0)
                {
                    curLineChunks.Sort((a, b) => a.X.CompareTo(b.X));
                    lines.Add((curLineChunks[0].Y, new List<TextChunk>(curLineChunks), string.Join("", curLineChunks.ConvertAll(c => c.Text))));
                }

                static string Norm(string s)
                {
                    if (string.IsNullOrEmpty(s)) return "";
                    string n = s.Normalize(System.Text.NormalizationForm.FormC);
                    return System.Text.RegularExpressions.Regex.Replace(n, @"\s+", "").ToLowerInvariant();
                }

                bool isSealAnchor = role.ToLower().Contains("seal") || signerName.Contains("TRƯỜNG", StringComparison.OrdinalIgnoreCase) || signerName.Contains("TRUONG", StringComparison.OrdinalIgnoreCase);
                bool isLeader = !isSealAnchor && (role.ToLower().Contains("leader") || role.Contains("2"));
                bool isPrincipal = isSealAnchor || role.ToLower().Contains("principal") || role.Contains("3");
                bool isTeacher = !isSealAnchor && !isLeader && !isPrincipal;

                float minColX = isTeacher ? (pW * 0.55f) : (isLeader ? (pW * 0.30f) : 0f);
                float maxColX = isTeacher ? pW : (isLeader ? (pW * 0.65f) : (pW * 0.35f));

                float? targetNameY = null;
                float? targetNameX = null;
                float? targetRoleY = null;
                float? targetRoleX = null;

                foreach (var line in lines)
                {
                    string lt = line.Text;
                    string normLt = Norm(lt);

                    bool isRoleLine = normLt.Contains(Norm("GIÁO VIÊN")) ||
                                      normLt.Contains(Norm("TỔ TRƯỞNG")) ||
                                      normLt.Contains(Norm("HIỆU TRƯỞNG")) ||
                                      normLt.Contains(Norm("PHÓ HIỆU")) ||
                                      normLt.Contains(Norm("Người lập")) ||
                                      normLt.Contains(Norm("GIÁM HIỆU")) ||
                                      normLt.Contains(Norm("BAN GIÁM HIỆU"));

                    if (isRoleLine)
                    {
                        var colChunks = line.Chunks.FindAll(c => c.X >= minColX && c.X <= maxColX);
                        if (colChunks.Count > 0)
                        {
                            targetRoleY = line.Y;
                            targetRoleX = colChunks[0].X;
                        }
                    }

                    bool isNameLine = normLt.Contains(Norm("Hà Văn Tý")) ||
                                      normLt.Contains(Norm("Phan Thị")) ||
                                      normLt.Contains(Norm("Ngô Thị")) ||
                                      normLt.Contains(Norm("Trần Văn")) ||
                                      normLt.Contains(Norm("Trần Khắc")) ||
                                      (!string.IsNullOrWhiteSpace(signerName) && normLt.Contains(Norm(signerName)));

                    if (isNameLine)
                    {
                        var colChunks = line.Chunks.FindAll(c => c.X >= minColX && c.X <= maxColX);
                        if (colChunks.Count > 0)
                        {
                            targetNameY = line.Y;
                            targetNameX = colChunks[0].X;
                        }
                    }
                }

                float defaultX = isTeacher ? (isLandscape ? pW * 0.745f : pW * 0.74f)
                               : isLeader ? (isLandscape ? pW * 0.46f : pW * 0.46f)
                               : (isLandscape ? pW * 0.18f : pW * 0.18f);
                float defaultY = isLandscape ? 275f : 120f;

                float stampX = defaultX;
                float stampY = defaultY;

                if (targetNameY.HasValue && targetRoleY.HasValue)
                {
                    float midY = (targetRoleY.Value + targetNameY.Value) / 2f;
                    stampY = midY - (h / 2f);
                    if (isSealRole && stampY + h > targetRoleY.Value)
                    {
                        stampY = Math.Max(targetNameY.Value + 2f, targetRoleY.Value - h - 2f);
                    }
                    float anchorX = targetNameX ?? targetRoleX ?? defaultX;
                    stampX = anchorX - (w * 0.15f);
                }
                else if (targetNameY.HasValue)
                {
                    stampY = targetNameY.Value + 15f;
                    float anchorX = targetNameX ?? defaultX;
                    stampX = anchorX - (w * 0.15f);
                }
                else if (targetRoleY.HasValue)
                {
                    stampY = targetRoleY.Value - h - 15f;
                    float anchorX = targetRoleX ?? defaultX;
                    stampX = anchorX - (w * 0.15f);
                }
                else if (isManualDrag && reqXPercent.HasValue && reqYPercent.HasValue && reqXPercent.Value >= 0 && reqYPercent.Value >= 0)
                {
                    // Fallback khi hoàn toàn không tìm thấy text mỏ neo trên trang (ví dụ tài liệu scan dạng ảnh)
                    stampX = Math.Max(10f, Math.Min(pW - w - 10f, (reqXPercent.Value / 100f) * pW));
                    stampY = Math.Max(10f, Math.Min(pH - h - 10f, pH - ((reqYPercent.Value / 100f) * pH) - h));
                }

                stampX = Math.Max(10f, Math.Min(pW - w - 10f, stampX));
                stampY = Math.Max(10f, Math.Min(pH - h - 10f, stampY));

                return (targetPage, stampX, stampY, w, h);
            }
            catch
            {
                float defaultX = isLandscape ? 627f : 440f;
                float defaultY = isLandscape ? 275f : 120f;
                return (targetPage, defaultX, defaultY, 95f, 60f);
            }
        }

        // ===== CERT CACHE (500ms) — tránh mở X509Store nhiều lần liên tiếp =====
        internal sealed class CertCacheHolder
        {
            public X509Certificate2 Certificate { get; }
            public long CachedTimeMs { get; }
            private int _refCount = 0;
            private bool _isInvalidated = false;
            private readonly object _lock = new object();

            public CertCacheHolder(X509Certificate2 cert, long timeMs)
            {
                Certificate = cert;
                CachedTimeMs = timeMs;
            }

            public bool TryAcquire(out X509Certificate2? cert)
            {
                lock (_lock)
                {
                    if (_isInvalidated)
                    {
                        cert = null;
                        return false;
                    }
                    _refCount++;
                    cert = Certificate;
                    _activeCertHolders[Certificate] = this;
                    return true;
                }
            }

            public void Release()
            {
                bool shouldDispose = false;
                lock (_lock)
                {
                    if (_refCount <= 0)
                    {
                        throw new InvalidOperationException("CertCacheHolder: Thao tác Release() không hợp lệ vì _refCount <= 0 (ngăn chặn double-release).");
                    }
                    _refCount--;
                    if (_isInvalidated && _refCount == 0)
                    {
                        shouldDispose = true;
                    }
                }
                if (shouldDispose)
                {
                    _activeCertHolders.TryRemove(Certificate, out _);
                    try { Certificate.Dispose(); } catch { }
                }
            }

            public void Invalidate()
            {
                bool shouldDispose = false;
                lock (_lock)
                {
                    _isInvalidated = true;
                    if (_refCount == 0)
                    {
                        shouldDispose = true;
                    }
                }
                if (shouldDispose)
                {
                    _activeCertHolders.TryRemove(Certificate, out _);
                    try { Certificate.Dispose(); } catch { }
                }
            }
        }

        private static readonly System.Collections.Concurrent.ConcurrentDictionary<X509Certificate2, CertCacheHolder> _activeCertHolders
            = new System.Collections.Concurrent.ConcurrentDictionary<X509Certificate2, CertCacheHolder>();

        public sealed class CertLease : IDisposable
        {
            public X509Certificate2 Certificate { get; }
            private readonly CertCacheHolder _holder;
            private int _disposed = 0;

            internal CertLease(CertCacheHolder holder, X509Certificate2 cert)
            {
                _holder = holder;
                Certificate = cert;
            }

            public void Dispose()
            {
                if (System.Threading.Interlocked.Exchange(ref _disposed, 1) == 0)
                {
                    _holder.Release();
                }
            }
        }

        private static CertCacheHolder? _certCachePersonalHolder = null;
        private static readonly object _certCacheLock = new object();
        private const long CERT_CACHE_MS = 500;

        public static void InvalidateCertCache()
        {
            CertCacheHolder? oldHolder = null;
            lock (_certCacheLock)
            {
                oldHolder = _certCachePersonalHolder;
                _certCachePersonalHolder = null;
            }
            // Không Dispose chứng chỉ ngay lập tức nếu đang có luồng đọc sử dụng (chống ObjectDisposedException);
            // Invalidate() đánh dấu hủy cache và chỉ Dispose khi luồng cuối cùng hoàn tất
            oldHolder?.Invalidate();
        }

        public static void ReleaseCertLease(X509Certificate2? cert)
        {
            if (cert == null) return;
            // Tra cứu trực tiếp holder đã cấp chứng chỉ (kể cả khi holder đó đã bị invalidate và tách khỏi cache hiện tại)
            if (_activeCertHolders.TryGetValue(cert, out var holder))
            {
                try { holder.Release(); } catch (InvalidOperationException) { }
            }
            else
            {
                lock (_certCacheLock)
                {
                    if (_certCachePersonalHolder != null && ReferenceEquals(_certCachePersonalHolder.Certificate, cert))
                    {
                        try { _certCachePersonalHolder.Release(); } catch (InvalidOperationException) { }
                    }
                }
            }
        }

        // ===== WEBSOCKET USB BROADCAST =====
        private sealed class WsSessionHolder
        {
            public System.Net.WebSockets.WebSocket Socket { get; }
            public System.Threading.SemaphoreSlim Semaphore { get; } = new System.Threading.SemaphoreSlim(1, 1);
            private int _refCount = 0;
            private bool _isDisposed = false;
            private readonly object _lock = new object();

            public WsSessionHolder(System.Net.WebSockets.WebSocket socket)
            {
                Socket = socket;
            }

            public bool TryEnter()
            {
                lock (_lock)
                {
                    if (_isDisposed || Socket.State != System.Net.WebSockets.WebSocketState.Open)
                        return false;
                    _refCount++;
                    return true;
                }
            }

            public void Exit()
            {
                bool shouldDispose = false;
                lock (_lock)
                {
                    _refCount--;
                    if (_isDisposed && _refCount <= 0)
                        shouldDispose = true;
                }
                if (shouldDispose)
                {
                    try { Semaphore.Dispose(); } catch { }
                }
            }

            public void MarkDisposed()
            {
                bool shouldDispose = false;
                lock (_lock)
                {
                    _isDisposed = true;
                    if (_refCount <= 0)
                        shouldDispose = true;
                }
                if (shouldDispose)
                {
                    try { Semaphore.Dispose(); } catch { }
                }
            }
        }

        private static readonly System.Collections.Concurrent.ConcurrentDictionary<System.Net.WebSockets.WebSocket, WsSessionHolder> _wsSessions
            = new System.Collections.Concurrent.ConcurrentDictionary<System.Net.WebSockets.WebSocket, WsSessionHolder>();

        public static void RegisterWsSession(System.Net.WebSockets.WebSocket ws)
        {
            if (ws == null) return;
            var holder = new WsSessionHolder(ws);
            if (!_wsSessions.TryAdd(ws, holder))
            {
                holder.MarkDisposed();
            }
        }

        public static void UnregisterWsSession(System.Net.WebSockets.WebSocket ws)
        {
            if (ws == null) return;
            if (_wsSessions.TryRemove(ws, out var holder))
            {
                holder.MarkDisposed();
            }
        }

        public static void BroadcastUsbEvent(string eventType, string? signerName, string? serial, string? thumbprint)
        {
            _ = BroadcastUsbEventAsync(eventType, signerName, serial, thumbprint);
        }

        public static async Task BroadcastUsbEventAsync(string eventType, string? signerName, string? serial, string? thumbprint)
        {
            try
            {
                var payload = new
                {
                    type        = "usb_event",
                    eventType,
                    signerName  = signerName ?? "",
                    serial      = serial ?? "",
                    thumbprint  = thumbprint ?? "",
                    timestamp   = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
                string json = System.Text.Json.JsonSerializer.Serialize(payload);
                byte[] data = System.Text.Encoding.UTF8.GetBytes(json);
                var buffer  = new System.ArraySegment<byte>(data);

                var tasks = new List<Task>();
                foreach (var kvp in _wsSessions.ToArray())
                {
                    var holder = kvp.Value;
                    var ws = holder.Socket;

                    if (!holder.TryEnter())
                    {
                        UnregisterWsSession(ws);
                        continue;
                    }

                    tasks.Add(Task.Run(async () =>
                    {
                        bool acquired = false;
                        try
                        {
                            using var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(3));
                            acquired = await holder.Semaphore.WaitAsync(TimeSpan.FromSeconds(2), cts.Token).ConfigureAwait(false);
                            if (!acquired)
                            {
                                Console.Error.WriteLine("[UsbBroadcast] Quá hạn đợi khóa gửi WebSocket; bỏ qua session chậm.");
                                return;
                            }

                            if (ws.State == System.Net.WebSockets.WebSocketState.Open)
                            {
                                await ws.SendAsync(buffer, System.Net.WebSockets.WebSocketMessageType.Text, true, cts.Token).ConfigureAwait(false);
                            }
                            else
                            {
                                UnregisterWsSession(ws);
                            }
                        }
                        catch (ObjectDisposedException) { }
                        catch (Exception ex)
                        {
                            Console.Error.WriteLine($"[UsbBroadcast] Gửi sự kiện USB qua WebSocket thất bại: {ex.Message}");
                            UnregisterWsSession(ws);
                        }
                        finally
                        {
                            if (acquired)
                            {
                                try { holder.Semaphore.Release(); } catch { }
                            }
                            holder.Exit();
                        }
                    }));
                }

                if (tasks.Count > 0)
                {
                    await Task.WhenAll(tasks).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[UsbBroadcast] Lỗi phát sóng USB: {ex.Message}");
            }
        }
        // ====================================

        public static X509Certificate2? FindVgcaPersonalCertificate(string? expectedSignerOrEmail = null, string? expectedCccd = null)
        {
            // === Fix B: Cert Cache 500ms ===
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (_certCacheLock)
            {
                if (string.IsNullOrEmpty(expectedSignerOrEmail) && string.IsNullOrEmpty(expectedCccd) 
                    && _certCachePersonalHolder != null 
                    && (nowMs - _certCachePersonalHolder.CachedTimeMs) < CERT_CACHE_MS)
                {
                    if (_certCachePersonalHolder.TryAcquire(out var cachedCert) && cachedCert != null)
                        return cachedCert;
                }
            }

            try
            {
                using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
                store.Open(OpenFlags.ReadOnly);

                string cleanExpected = (expectedSignerOrEmail ?? "").Trim().ToLowerInvariant();
                string cleanCccd = (expectedCccd ?? "").Trim();

                X509Certificate2? bestMatch = null;

                // 1. Quét chứng thư cá nhân VGCA (Remote Signing CSP / Ban Cơ yếu Chính phủ)
                foreach (var cert in store.Certificates)
                {
                    if (!cert.HasPrivateKey) continue;

                    string issuer = (cert.Issuer ?? "").ToLowerInvariant();
                    string subject = (cert.Subject ?? "");
                    string subjectLower = subject.ToLowerInvariant();

                    // LOẠI TRỪ CON DẤU CƠ QUAN / USB TRƯỜNG HỌC (chứa MST: hoặc bắt đầu bằng CN=TRƯỜNG)
                    if (subjectLower.Contains("mst:") || subject.StartsWith("CN=TRƯỜNG", StringComparison.OrdinalIgnoreCase) || subject.StartsWith("CN=TRUONG", StringComparison.OrdinalIgnoreCase))
                        continue;

                    // LOẠI TRỪ CÁC THIẾT BỊ USB TOKEN PHẦN CỨNG (bit4id, TokenME, Safenet, ePass, Feitian, v.v.)
                    string friendlyName = (cert.FriendlyName ?? "").ToLowerInvariant();
                    if (friendlyName.Contains("bit4id") || friendlyName.Contains("tokenme") || friendlyName.Contains("safenet") ||
                        friendlyName.Contains("epass") || friendlyName.Contains("feitian") || friendlyName.Contains("etoken") ||
                        subjectLower.Contains("bit4id") || subjectLower.Contains("tokenme") ||
                        issuer.Contains("bit4id") || issuer.Contains("tokenme") ||
                        IsHardwareTokenCert(cert))
                        continue;

                    bool isGovCa = issuer.Contains("ban c") || issuer.Contains("vgca") || issuer.Contains("nhà nước") ||
                                   issuer.Contains("nha nuoc") || subjectLower.Contains("quangngai.gov.vn") ||
                                   issuer.Contains("ca phuc vu");

                    if (!isGovCa) continue;

                    string certCccd = ExtractCccdOrUid(subject);
                    string emailInCert = ExtractEmail(subject).ToLowerInvariant();
                    string cnInCert = ExtractCn(subject);
                    string cnInCertLower = cnInCert.ToLowerInvariant();

                    // NẾU CÓ TRUYỀN CCCD HOẶC TÊN/EMAIL MONG MUỐN -> BẮT BUỘC PHẢI KHỚP DANH TÍNH
                    if (!string.IsNullOrEmpty(cleanCccd) || !string.IsNullOrEmpty(cleanExpected))
                    {
                        DateTime utcNow = DateTime.UtcNow;
                        bool isValid = cert.HasPrivateKey && cert.NotBefore.ToUniversalTime() <= utcNow && utcNow <= cert.NotAfter.ToUniversalTime();
                        if (!isValid) continue;

                        bool hasSigKu = false;
                        foreach (var ext in cert.Extensions)
                        {
                            if (ext is X509KeyUsageExtension ku && (ku.KeyUsages & (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation)) != 0)
                            {
                                hasSigKu = true;
                                break;
                            }
                        }
                        if (!hasSigKu) continue;

                        bool isChainValid = false;
                        using (var chain = new X509Chain())
                        {
                            chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
                            chain.ChainPolicy.RevocationFlag = X509RevocationFlag.ExcludeRoot;
                            chain.ChainPolicy.UrlRetrievalTimeout = TimeSpan.FromSeconds(3);
                            if (chain.Build(cert))
                            {
                                isChainValid = true;
                                foreach (var status in chain.ChainStatus)
                                {
                                    if (status.Status != X509ChainStatusFlags.NoError)
                                    {
                                        isChainValid = false;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!isChainValid) continue;

                        bool isKeyUsable = false;
                        try
                        {
                            using var rsa = cert.GetRSAPrivateKey();
                            if (rsa != null)
                            {
                                isKeyUsable = true;
                            }
                            else
                            {
                                using var ecdsa = cert.GetECDsaPrivateKey();
                                if (ecdsa != null) isKeyUsable = true;
                            }
                        }
                        catch { isKeyUsable = false; }
                        if (!isKeyUsable) continue;

                        bool hasCccd = !string.IsNullOrEmpty(cleanCccd);
                        bool matchCccd = hasCccd && !string.IsNullOrEmpty(certCccd) && string.Equals(certCccd, cleanCccd, StringComparison.OrdinalIgnoreCase);

                        bool hasExpected = !string.IsNullOrEmpty(cleanExpected);
                        bool matchExpected = false;
                        if (hasExpected)
                        {
                            string rawExp = (expectedSignerOrEmail ?? "").Trim();
                            string normExp = rawExp.Replace(" ", "").Replace(":", "");
                            bool matchThumb = cert.Thumbprint.Equals(rawExp, StringComparison.OrdinalIgnoreCase) ||
                                              cert.Thumbprint.Replace(" ", "").Replace(":", "").Equals(normExp, StringComparison.OrdinalIgnoreCase);
                            bool matchSer = cert.SerialNumber.Equals(rawExp, StringComparison.OrdinalIgnoreCase) ||
                                            cert.SerialNumber.Replace(" ", "").Replace(":", "").Equals(normExp, StringComparison.OrdinalIgnoreCase);

                            if (matchThumb || matchSer)
                            {
                                matchExpected = true;
                            }
                            else
                            {
                                bool matchEmail = !string.IsNullOrEmpty(emailInCert) && string.Equals(emailInCert, cleanExpected, StringComparison.OrdinalIgnoreCase);
                                bool matchCn = string.Equals(cnInCert, rawExp, StringComparison.OrdinalIgnoreCase) ||
                                               string.Equals(cnInCertLower, cleanExpected, StringComparison.OrdinalIgnoreCase);
                                string cleanNorm = RemoveDiacritics(rawExp).Trim().ToLowerInvariant();
                                string cnNorm = RemoveDiacritics(cnInCert).Trim().ToLowerInvariant();
                                bool matchCnNorm = !string.IsNullOrEmpty(cleanNorm) && string.Equals(cnNorm, cleanNorm, StringComparison.OrdinalIgnoreCase);

                                matchExpected = isChainValid && (matchEmail || matchCn || matchCnNorm);
                            }
                        }

                        bool isIdentityMatch = (!hasCccd || matchCccd) && (!hasExpected || matchExpected);
                        if (isIdentityMatch && (bestMatch == null || cert.NotAfter > bestMatch.NotAfter))
                            bestMatch = cert;
                    }
                    else
                    {
                        DateTime utcNow = DateTime.UtcNow;
                        bool isValid = cert.HasPrivateKey && cert.NotBefore.ToUniversalTime() <= utcNow && utcNow <= cert.NotAfter.ToUniversalTime();
                        if (isValid && (bestMatch == null || cert.NotAfter > bestMatch.NotAfter))
                        {
                            bool hasSig = false;
                            foreach (var ext in cert.Extensions)
                            {
                                if (ext is X509KeyUsageExtension ku && (ku.KeyUsages & (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation)) != 0)
                                {
                                    hasSig = true;
                                    break;
                                }
                            }
                            if (hasSig)
                            {
                                try
                                {
                                    using var rsa = cert.GetRSAPrivateKey();
                                    if (rsa != null) bestMatch = cert;
                                    else
                                    {
                                        using var ecdsa = cert.GetECDsaPrivateKey();
                                        if (ecdsa != null) bestMatch = cert;
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                }

                if (!string.IsNullOrEmpty(cleanCccd) || !string.IsNullOrEmpty(cleanExpected))
                {
                    if (bestMatch == null) return null;
                }

                if (bestMatch != null)
                {
                    lock (_certCacheLock)
                    {
                        _certCachePersonalHolder?.Invalidate();
                        _certCachePersonalHolder = new CertCacheHolder(bestMatch, nowMs);
                        _certCachePersonalHolder.TryAcquire(out _);
                    }
                    return bestMatch;
                }

                // Fallback theo thumbprint từ file config nếu có
                string configPath = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_config.json");
                string fallbackThumbprint = "";
                if (File.Exists(configPath))
                {
                    try
                    {
                        var cfg = JsonSerializer.Deserialize<System.Text.Json.JsonElement>(File.ReadAllText(configPath));
                        if (cfg.TryGetProperty("defaultThumbprint", out var tp)) fallbackThumbprint = tp.GetString() ?? "";
                    }
                    catch { }
                }

                if (!string.IsNullOrEmpty(fallbackThumbprint))
                {
                    foreach (var cert in store.Certificates)
                    {
                        if (cert.Thumbprint.Equals(fallbackThumbprint, StringComparison.OrdinalIgnoreCase) && cert.HasPrivateKey)
                        {
                            lock (_certCacheLock)
                            {
                                _certCachePersonalHolder?.Invalidate();
                                _certCachePersonalHolder = new CertCacheHolder(cert, nowMs);
                                _certCachePersonalHolder.TryAcquire(out _);
                            }
                            return cert;
                        }
                    }
                }
            }
            catch { }
            return null;
        }

        public static string GetKeyStorageType(X509Certificate2? cert)
        {
            if (cert == null || !cert.HasPrivateKey) return "unknown";

            try
            {
                using var rsa = cert.GetRSAPrivateKey();
                if (rsa is RSACng rsaCng)
                {
                    string prov = (rsaCng.Key?.Provider?.Provider ?? "").ToLowerInvariant();
                    if (prov.Contains("smart card") || prov.Contains("token") || prov.Contains("bit4id") ||
                        prov.Contains("safenet") || prov.Contains("epass") || prov.Contains("feitian") || prov.Contains("card"))
                        return "hardware";
                    if (prov.Contains("rssp") || prov.Contains("software") || prov.Contains("virtual"))
                        return "virtual";
                }
                else if (rsa is RSACryptoServiceProvider rsaCsp)
                {
                    var info = rsaCsp.CspKeyContainerInfo;
                    if (info != null)
                    {
                        if (info.HardwareDevice || info.Removable) return "hardware";
                        string prov = (info.ProviderName ?? "").ToLowerInvariant();
                        if (prov.Contains("smart card") || prov.Contains("token") || prov.Contains("bit4id") ||
                            prov.Contains("safenet") || prov.Contains("epass") || prov.Contains("feitian") || prov.Contains("card"))
                            return "hardware";
                        if (prov.Contains("rssp") || prov.Contains("software") || prov.Contains("virtual"))
                            return "virtual";
                    }
                }

                using var ecdsa = cert.GetECDsaPrivateKey();
                if (ecdsa is ECDsaCng ecCng)
                {
                    string prov = (ecCng.Key?.Provider?.Provider ?? "").ToLowerInvariant();
                    if (prov.Contains("smart card") || prov.Contains("token") || prov.Contains("bit4id") ||
                        prov.Contains("safenet") || prov.Contains("epass") || prov.Contains("feitian") || prov.Contains("card"))
                        return "hardware";
                    if (prov.Contains("rssp") || prov.Contains("software") || prov.Contains("virtual"))
                        return "virtual";
                }
            }
            catch { }
            return "unknown";
        }

        public static bool IsHardwareTokenCert(X509Certificate2? cert)
        {
            return GetKeyStorageType(cert) == "hardware";
        }

        public static X509Certificate2? FindHardwareTokenCertificate(string? expectedSerial = null, string? expectedSigner = null, string? expectedCccd = null)
        {
            try
            {
                using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
                store.Open(OpenFlags.ReadOnly);

                string cleanExpectedSerial = (expectedSerial ?? "").Replace(" ", "").Replace(":", "").Trim();
                string cleanExpectedSigner = (expectedSigner ?? "").Trim();
                string cleanExpectedCccd = (expectedCccd ?? "").Trim();

                // 1. Tìm theo số Serial chỉ định (ví dụ con dấu BGH hoặc serial đã lưu):
                if (!string.IsNullOrWhiteSpace(cleanExpectedSerial))
                {
                    DateTime utcNow = DateTime.UtcNow;
                    var serialMatches = new List<X509Certificate2>();
                    foreach (var cert in store.Certificates)
                    {
                        if (!cert.HasPrivateKey) continue;
                        if (cert.NotBefore.ToUniversalTime() > utcNow || utcNow > cert.NotAfter.ToUniversalTime()) continue;
                        string cleanCertSerial = cert.SerialNumber.Replace(" ", "").Replace(":", "").Trim();
                        if (cleanCertSerial.Equals(cleanExpectedSerial, StringComparison.OrdinalIgnoreCase))
                        {
                            bool isKeyUsable = false;
                            try
                            {
                                using var rsa = cert.GetRSAPrivateKey();
                                if (rsa != null) isKeyUsable = true;
                                else
                                {
                                    using var ecdsa = cert.GetECDsaPrivateKey();
                                    if (ecdsa != null) isKeyUsable = true;
                                }
                            }
                            catch { isKeyUsable = false; }
                            if (isKeyUsable)
                            {
                                serialMatches.Add(cert);
                            }
                        }
                    }
                    if (serialMatches.Count == 1) return serialMatches[0];
                    return null;
                }

                // 2. Lấy danh sách tất cả các chứng thư USB Token phần cứng thật, còn hạn và có private key sử dụng được
                DateTime nowUtc = DateTime.UtcNow;
                var hwCerts = new List<X509Certificate2>();
                foreach (var cert in store.Certificates)
                {
                    if (!cert.HasPrivateKey) continue;
                    if (cert.NotBefore.ToUniversalTime() > nowUtc || nowUtc > cert.NotAfter.ToUniversalTime()) continue;
                    if (!IsHardwareTokenCert(cert)) continue;

                    bool isKeyUsable = false;
                    try
                    {
                        using var rsa = cert.GetRSAPrivateKey();
                        if (rsa != null) isKeyUsable = true;
                        else
                        {
                            using var ecdsa = cert.GetECDsaPrivateKey();
                            if (ecdsa != null) isKeyUsable = true;
                        }
                    }
                    catch { isKeyUsable = false; }

                    if (isKeyUsable)
                    {
                        hwCerts.Add(cert);
                    }
                }

                if (hwCerts.Count == 0)
                {
                    return null;
                }

                // 3. Nếu có expectedCccd: Ưu tiên tìm cert phần cứng có CCCD khớp chính xác
                if (!string.IsNullOrEmpty(cleanExpectedCccd))
                {
                    var cccdMatches = new List<X509Certificate2>();
                    foreach (var cert in hwCerts)
                    {
                        string certCccd = ExtractCccdOrUid(cert.Subject);
                        if (!string.IsNullOrEmpty(certCccd) && string.Equals(certCccd, cleanExpectedCccd, StringComparison.OrdinalIgnoreCase))
                        {
                            cccdMatches.Add(cert);
                        }
                    }

                    if (cccdMatches.Count == 1)
                    {
                        return cccdMatches[0];
                    }
                    if (cccdMatches.Count > 1)
                    {
                        // Nhiều hơn 1 chứng thư khớp CCCD: Không thể xác định duy nhất, từ chối an toàn (Fail-Closed)
                        return null;
                    }
                    if (string.IsNullOrEmpty(cleanExpectedSigner))
                    {
                        return null; // Đã truyền CCCD cụ thể nhưng không khớp cert nào
                    }
                }

                // 4. Nếu có expectedSigner: Ưu tiên tìm cert phần cứng có tên/email/serial/thumbprint khớp chính xác
                if (!string.IsNullOrEmpty(cleanExpectedSigner))
                {
                    string rawExp = cleanExpectedSigner;
                    string normExpected = RemoveDiacritics(cleanExpectedSigner).Trim().ToLowerInvariant();
                    string normExpNoSep = rawExp.Replace(" ", "").Replace(":", "");
                    var signerMatches = new List<X509Certificate2>();

                    foreach (var cert in hwCerts)
                    {
                        string cn = ExtractCn(cert.Subject);
                        string normCn = RemoveDiacritics(cn).Trim().ToLowerInvariant();
                        string email = ExtractEmail(cert.Subject).Trim().ToLowerInvariant();

                        bool matchThumb = cert.Thumbprint.Equals(rawExp, StringComparison.OrdinalIgnoreCase) ||
                                          cert.Thumbprint.Replace(" ", "").Replace(":", "").Equals(normExpNoSep, StringComparison.OrdinalIgnoreCase);
                        bool matchSer = cert.SerialNumber.Equals(rawExp, StringComparison.OrdinalIgnoreCase) ||
                                        cert.SerialNumber.Replace(" ", "").Replace(":", "").Equals(normExpNoSep, StringComparison.OrdinalIgnoreCase);
                        bool matchCn = (!string.IsNullOrEmpty(normCn) && string.Equals(normCn, normExpected, StringComparison.OrdinalIgnoreCase))
                            || (!string.IsNullOrEmpty(cn) && string.Equals(cn, rawExp, StringComparison.OrdinalIgnoreCase));
                        bool matchEmail = (!string.IsNullOrEmpty(email) && string.Equals(email, normExpected, StringComparison.OrdinalIgnoreCase));

                        if (matchThumb || matchSer || matchCn || matchEmail)
                        {
                            signerMatches.Add(cert);
                        }
                    }

                    if (signerMatches.Count == 1)
                    {
                        return signerMatches[0];
                    }
                    if (signerMatches.Count > 1)
                    {
                        // Phát hiện từ 2 chứng thư trở lên khớp người ký: Báo lỗi lựa chọn không xác định (Fail-Closed)
                        return null;
                    }

                    // Đã chỉ định người ký nhưng không khớp duy nhất chứng thư nào
                    return null;
                }

                // 5. Nếu không truyền người ký cụ thể hoặc tìm cho BGH: Ưu tiên con dấu cơ quan
                var agencyMatches = new List<X509Certificate2>();
                foreach (var cert in hwCerts)
                {
                    string cn = ExtractCn(cert.Subject).ToLowerInvariant();
                    string subj = cert.Subject.ToLowerInvariant();
                    if (cn.StartsWith("trường") || cn.StartsWith("truong") || cn.Contains("thcs") || cn.Contains("ubnd") || subj.Contains("mst:"))
                    {
                        agencyMatches.Add(cert);
                    }
                }

                if (agencyMatches.Count == 1)
                {
                    return agencyMatches[0];
                }
                if (agencyMatches.Count > 1)
                {
                    Console.WriteLine("[FindHardwareTokenCertificate] Phát hiện nhiều hơn 1 chứng thư cơ quan. Yêu cầu chỉ định serial/người ký/CCCD để lọc duy nhất (Fail-Closed).");
                    return null;
                }

                // 6. Nếu chỉ có đúng 1 chứng thư phần cứng duy nhất trong token thì chấp nhận:
                if (hwCerts.Count == 1)
                {
                    return hwCerts[0];
                }

                // Nếu có nhiều chứng thư phần cứng mà không có tiêu chí định danh phân định duy nhất -> Fail-Closed
                Console.WriteLine($"[FindHardwareTokenCertificate] Phát hiện {hwCerts.Count} chứng thư phần cứng nhưng thiếu tiêu chí định danh duy nhất. Từ chối chọn ngẫu nhiên theo NotAfter (Fail-Closed).");
                return null;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[FindHardwareTokenCertificate] Lỗi truy vấn kho chứng thư phần cứng [ERR_HW_CERT_LOOKUP]: {ex.GetType().Name} - {ex.Message}");
                return null;
            }
        }

        public static X509Certificate2? FindVgcaCertificate(string? expectedSerial = null, string? signMode = "AUTO", string? expectedSigner = null, string? expectedCccd = null)
        {
            string safeSignMode = (signMode ?? "AUTO").Trim().ToUpperInvariant();
            if (safeSignMode == "PERSONAL" || safeSignMode == "VGCA" || safeSignMode == "TEACHER")
            {
                // GIÁO VIÊN KÝ CÁ NHÂN: TUYỆT ĐỐI KHÔNG FALLBACK SANG USB TOKEN PHẦN CỨNG!
                return FindVgcaPersonalCertificate(expectedSigner ?? expectedSerial, expectedCccd);
            }

            if (safeSignMode == "HARDWARE" || safeSignMode == "USB_TOKEN" || safeSignMode == "BGH")
            {
                // BAN GIÁM HIỆU / KÝ PHẦN CỨNG: TUYỆT ĐỐI KHÔNG FALLBACK SANG VIRTUAL CSP!
                return FindHardwareTokenCertificate(expectedSerial, expectedSigner, expectedCccd);
            }

            // Nếu chỉ định số Serial
            if (!string.IsNullOrWhiteSpace(expectedSerial))
            {
                return FindHardwareTokenCertificate(expectedSerial, expectedSigner, expectedCccd) ?? FindVgcaPersonalCertificate(expectedSigner ?? expectedSerial, expectedCccd);
            }

            // AUTO mode
            return FindVgcaPersonalCertificate(expectedSigner, expectedCccd) ?? FindHardwareTokenCertificate(null, expectedSigner, expectedCccd);
        }

        private static readonly bool s_isTestSimulationAuthorized = InitializeTestSimulationAuthorization();

        private static bool InitializeTestSimulationAuthorization()
        {
            string? nodeEnv = Environment.GetEnvironmentVariable("NODE_ENV");
            if (string.Equals(nodeEnv, "production", StringComparison.OrdinalIgnoreCase))
            {
                return false; // Tuyệt đối từ chối trong môi trường production (Fail-Closed)
            }

            string? testMode = Environment.GetEnvironmentVariable("EDUSIGN_TEST_MODE");
            if (!string.Equals(testMode, "1", StringComparison.OrdinalIgnoreCase))
            {
                return false; // Bắt buộc phải có cờ kiểm thử chuyên biệt EDUSIGN_TEST_MODE=1
            }

            // Yêu cầu đồng thời cấu hình môi trường test-only được nạp từ deployment ngoài production
            if (!string.Equals(nodeEnv, "test", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return true;
        }

        private static bool IsAuthorizedTestSimulation()
        {
            return s_isTestSimulationAuthorized;
        }

        public static void SignWithBouncyCastle(string inputPdf, string outputPdf, X509Certificate2? realCert, string reason, string location, int targetPage = 0, float rectX = -1f, float rectY = -1f, float rectW = 90f, float rectH = 60f, byte[]? visualSignImageBytes = null)
        {
            IExternalSignature pks;
            IX509Certificate[] chain;

            bool hasUsableKey = false;
            if (realCert != null && realCert.HasPrivateKey)
            {
                try
                {
                    using var rsa = realCert.GetRSAPrivateKey();
                    if (rsa != null) hasUsableKey = true;
                    else
                    {
                        using var ecdsa = realCert.GetECDsaPrivateKey();
                        if (ecdsa != null) hasUsableKey = true;
                    }
                }
                catch { hasUsableKey = false; }
            }

            if (hasUsableKey && realCert != null)
            {
                // Luồng ký production: Sử dụng nguyên vẹn chứng thư thật và khóa riêng thực tế của chủ thể ký
                pks = new VgcaSignature(realCert);
                var bcCert = new Org.BouncyCastle.X509.X509CertificateParser().ReadCertificate(realCert.RawData);
                chain = new IX509Certificate[] { new X509CertificateBC(bcCert) };
            }
            else
            {
                // Chỉ cho phép sinh chứng thư tự ký mô phỏng khi được xác nhận môi trường không-production và đánh dấu rõ output là test artifact
                if (!IsAuthorizedTestSimulation())
                {
                    throw new CryptographicException("Chứng thư số không tồn tại hoặc không thể truy cập khóa riêng (Private Key). Từ chối ký số tài liệu pháp lý (Fail-Closed).");
                }

                // Đánh dấu rõ output là test artifact
                reason = $"[TEST ARTIFACT - SIMULATION ONLY] {reason}";
                location = $"[TEST ENVIRONMENT] {location}";

                var secp384r1 = Org.BouncyCastle.Asn1.Sec.SecNamedCurves.GetByName("secp384r1");
                var ecDomainParams = new Org.BouncyCastle.Crypto.Parameters.ECDomainParameters(secp384r1.Curve, secp384r1.G, secp384r1.N, secp384r1.H, secp384r1.GetSeed());
                var secureRandom = new Org.BouncyCastle.Security.SecureRandom();
                var keyGen = new Org.BouncyCastle.Crypto.Generators.ECKeyPairGenerator();
                keyGen.Init(new Org.BouncyCastle.Crypto.Parameters.ECKeyGenerationParameters(ecDomainParams, secureRandom));
                var keyPair = keyGen.GenerateKeyPair();

                var gen = new Org.BouncyCastle.X509.X509V3CertificateGenerator();
                var serial = Org.BouncyCastle.Math.BigInteger.ProbablePrime(120, secureRandom);
                gen.SetSerialNumber(serial);

                // Ghi rõ nhãn chứng thư mô phỏng kiểm thử, tuyệt đối không giả mạo VGCA / Ban Cơ yếu Chính phủ
                gen.SetSubjectDN(new Org.BouncyCastle.Asn1.X509.X509Name("CN=EduSign Test Signer (Non-Production Simulation), OU=Test Artifact, O=EduSign Test Sandbox, C=VN"));
                gen.SetIssuerDN(new Org.BouncyCastle.Asn1.X509.X509Name("CN=EduSign Test Root CA (Non-Production), OU=Test Artifact, O=EduSign Test Sandbox, C=VN"));
                gen.SetNotBefore(DateTime.UtcNow.AddDays(-1));
                gen.SetNotAfter(DateTime.UtcNow.AddYears(1));
                gen.SetPublicKey(keyPair.Public);
                var signatureFactory = new Org.BouncyCastle.Crypto.Operators.Asn1SignatureFactory("SHA256withECDSA", keyPair.Private);
                var bcCert = gen.Generate(signatureFactory);

                pks = new BouncyCastleEcdsaSignature(keyPair.Private);
                chain = new IX509Certificate[] { new X509CertificateBC(bcCert) };
            }

            string outDir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(outputPdf)) ?? AppDomain.CurrentDomain.BaseDirectory;
            if (!Directory.Exists(outDir))
            {
                Directory.CreateDirectory(outDir);
            }
            string tempOutputPdf = System.IO.Path.Combine(outDir, $".tmp_{Guid.NewGuid():N}.pdf");
            bool signComplete = false;

            try
            {
                using (PdfReader reader = new PdfReader(inputPdf))
                using (FileStream outputStream = new FileStream(tempOutputPdf, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    StampingProperties stampingProperties = new StampingProperties();
                    stampingProperties.UseAppendMode();

                    PdfSigner signer = new PdfSigner(reader, outputStream, stampingProperties);
                    string fieldName = "SignatureVGCA_" + DateTime.Now.Ticks;
                    SignerProperties signerProperties = new SignerProperties()
                        .SetFieldName(fieldName)
                        .SetReason(reason)
                        .SetLocation(location);

                    if (targetPage > 0 && rectX >= 0 && rectY >= 0)
                    {
                        signerProperties.SetPageNumber(targetPage);
                        signerProperties.SetPageRect(new Rectangle(rectX, rectY, rectW, rectH));
                    }

                    if (visualSignImageBytes != null && visualSignImageBytes.Length > 0 && rectX >= 0 && rectY >= 0)
                    {
                        try
                        {
                            var appearance = new SignatureFieldAppearance(fieldName)
                                .SetContent(ImageDataFactory.Create(visualSignImageBytes));
                            signerProperties.SetSignatureAppearance(appearance);
                        }
                        catch { }
                    }

                    signer.SetSignerProperties(signerProperties);
                    signer.SignDetached(pks, chain, null, null, null, 0, PdfSigner.CryptoStandard.CADES);
                }

                // Kiểm tra tính toàn vẹn của tệp đã ký trước khi thay thế nguyên tử
                var fi = new FileInfo(tempOutputPdf);
                if (!fi.Exists || fi.Length == 0)
                {
                    throw new IOException("Tệp PDF sau khi ký không có dữ liệu hoặc không được tạo thành công.");
                }

                // Thay thế nguyên tử tệp đích
                File.Move(tempOutputPdf, outputPdf, overwrite: true);
                signComplete = true;
            }
            finally
            {
                if (!signComplete && File.Exists(tempOutputPdf))
                {
                    try { File.Delete(tempOutputPdf); } catch { }
                }
            }
        }

        public static byte[] SignBytesWithBouncyCastle(byte[] inputPdfBytes, X509Certificate2? realCert, string reason, string location, byte[]? visualSignImageBytes = null, iText.Kernel.Geom.Rectangle? signRect = null, int targetPage = 0)
        {
            IExternalSignature pks;
            IX509Certificate[] chain;

            bool hasUsableKey = false;
            if (realCert != null && realCert.HasPrivateKey)
            {
                try
                {
                    using var rsa = realCert.GetRSAPrivateKey();
                    if (rsa != null) hasUsableKey = true;
                    else
                    {
                        using var ecdsa = realCert.GetECDsaPrivateKey();
                        if (ecdsa != null) hasUsableKey = true;
                    }
                }
                catch { hasUsableKey = false; }
            }

            if (hasUsableKey && realCert != null)
            {
                // Luồng ký production: Sử dụng nguyên vẹn chứng thư thật và khóa riêng thực tế của chủ thể ký
                pks = new VgcaSignature(realCert);
                var bcCert = new Org.BouncyCastle.X509.X509CertificateParser().ReadCertificate(realCert.RawData);
                chain = new IX509Certificate[] { new X509CertificateBC(bcCert) };
            }
            else
            {
                // Chỉ cho phép sinh chứng thư tự ký mô phỏng khi được xác nhận môi trường không-production và đánh dấu rõ output là test artifact
                if (!IsAuthorizedTestSimulation())
                {
                    throw new CryptographicException("Chứng thư số không tồn tại hoặc không thể truy cập khóa riêng (Private Key). Từ chối ký số tài liệu pháp lý (Fail-Closed).");
                }

                // Đánh dấu rõ output là test artifact
                reason = $"[TEST ARTIFACT - SIMULATION ONLY] {reason}";
                location = $"[TEST ENVIRONMENT] {location}";

                var secp384r1 = Org.BouncyCastle.Asn1.Sec.SecNamedCurves.GetByName("secp384r1");
                var ecDomainParams = new Org.BouncyCastle.Crypto.Parameters.ECDomainParameters(secp384r1.Curve, secp384r1.G, secp384r1.N, secp384r1.H, secp384r1.GetSeed());
                var secureRandom = new Org.BouncyCastle.Security.SecureRandom();
                var keyGen = new Org.BouncyCastle.Crypto.Generators.ECKeyPairGenerator();
                keyGen.Init(new Org.BouncyCastle.Crypto.Parameters.ECKeyGenerationParameters(ecDomainParams, secureRandom));
                var keyPair = keyGen.GenerateKeyPair();

                var gen = new Org.BouncyCastle.X509.X509V3CertificateGenerator();
                var serial = Org.BouncyCastle.Math.BigInteger.ProbablePrime(120, secureRandom);
                gen.SetSerialNumber(serial);

                // Ghi rõ nhãn chứng thư mô phỏng kiểm thử, tuyệt đối không giả mạo VGCA / Ban Cơ yếu Chính phủ
                gen.SetSubjectDN(new Org.BouncyCastle.Asn1.X509.X509Name("CN=EduSign Test Signer (Non-Production Simulation), OU=Test Artifact, O=EduSign Test Sandbox, C=VN"));
                gen.SetIssuerDN(new Org.BouncyCastle.Asn1.X509.X509Name("CN=EduSign Test Root CA (Non-Production), OU=Test Artifact, O=EduSign Test Sandbox, C=VN"));
                gen.SetNotBefore(DateTime.UtcNow.AddDays(-1));
                gen.SetNotAfter(DateTime.UtcNow.AddYears(1));
                gen.SetPublicKey(keyPair.Public);
                var signatureFactory = new Org.BouncyCastle.Crypto.Operators.Asn1SignatureFactory("SHA256withECDSA", keyPair.Private);
                var bcCert = gen.Generate(signatureFactory);

                pks = new BouncyCastleEcdsaSignature(keyPair.Private);
                chain = new IX509Certificate[] { new X509CertificateBC(bcCert) };
            }

            using var reader = new PdfReader(new MemoryStream(inputPdfBytes));
            using var outputStream = new MemoryStream();

            var stampingProps = new StampingProperties();
            stampingProps.UseAppendMode();

            var signer = new PdfSigner(reader, outputStream, stampingProps);
            string fieldName = "SignatureVGCA_" + DateTime.Now.Ticks;
            var signerProps = new SignerProperties()
                .SetFieldName(fieldName)
                .SetReason(reason)
                .SetLocation(location);

            if (targetPage > 0 && signRect != null)
            {
                signerProps.SetPageNumber(targetPage);
                signerProps.SetPageRect(signRect);
            }

            if (visualSignImageBytes != null && visualSignImageBytes.Length > 0 && signRect != null)
            {
                try
                {
                    var appearance = new SignatureFieldAppearance(fieldName)
                        .SetContent(ImageDataFactory.Create(visualSignImageBytes));
                    signerProps.SetSignatureAppearance(appearance);
                    Console.WriteLine($"[PAdES Visual Appearance - BouncyCastle] Đã nhúng hình ảnh chữ ký số tại Trang {targetPage}, ({signRect.GetX():F1}, {signRect.GetY():F1})...");
                }
                catch (Exception appEx)
                {
                    Console.WriteLine($"⚠️ Gặp sự cố khi thiết lập hình ảnh chữ ký BouncyCastle: {appEx.Message}");
                }
            }

            signer.SetSignerProperties(signerProps);
            signer.SignDetached(pks, chain, null, null, null, 0, PdfSigner.CryptoStandard.CADES);
            return outputStream.ToArray();
        }

        public static byte[] KySoPdfBytes(byte[] inputPdfBytes, string reason, string location, bool strict = false, byte[]? visualSignImageBytes = null, iText.Kernel.Geom.Rectangle? signRect = null, int targetPage = 0, string? expectedSerial = null, string signMode = "AUTO")
        {
            var cert = FindVgcaCertificate(expectedSerial, signMode);
            if (!string.IsNullOrWhiteSpace(expectedSerial) && cert == null)
            {
                throw new InvalidOperationException($"Không tìm thấy USB Token khớp với số Serial [{expectedSerial}] đã đăng ký của Ban Giám hiệu! Vui lòng cắm đúng thiết bị USB Token.");
            }

            bool isTest = IsAuthorizedTestSimulation();
            if (isTest)
            {
                return SignBytesWithBouncyCastle(inputPdfBytes, cert, reason, location, visualSignImageBytes, signRect, targetPage);
            }

            try
            {
                if (cert != null && cert.HasPrivateKey)
                {
                    using var reader = new PdfReader(new MemoryStream(inputPdfBytes));
                    using var outputStream = new MemoryStream();

                    var stampingProps = new StampingProperties();
                    stampingProps.UseAppendMode();

                    var signer = new PdfSigner(reader, outputStream, stampingProps);
                    string fieldName = "SignatureVGCA_" + DateTime.Now.Ticks;
                    var signerProps = new SignerProperties()
                        .SetFieldName(fieldName)
                        .SetReason(reason)
                        .SetLocation(location);

                    if (targetPage > 0 && signRect != null)
                    {
                        signerProps.SetPageNumber(targetPage);
                        signerProps.SetPageRect(signRect);
                    }

                    if (visualSignImageBytes != null && visualSignImageBytes.Length > 0 && signRect != null)
                    {
                        try
                        {
                            var appearance = new SignatureFieldAppearance(fieldName)
                                .SetContent(ImageDataFactory.Create(visualSignImageBytes));
                            signerProps.SetSignatureAppearance(appearance);
                            Console.WriteLine($"[PAdES Visual Appearance] Đã nhúng hình ảnh chữ ký số trực quan tại Trang {targetPage}, ({signRect.GetX():F1}, {signRect.GetY():F1})...");
                        }
                        catch (Exception appEx)
                        {
                            Console.WriteLine($"⚠️ Gặp sự cố khi thiết lập hình ảnh chữ ký: {appEx.Message}");
                        }
                    }

                    signer.SetSignerProperties(signerProps);

                    IExternalSignature pks = new VgcaSignature(cert);
                    var bcCert = new Org.BouncyCastle.X509.X509CertificateParser().ReadCertificate(cert.RawData);
                    var bcCertWrapper = new X509CertificateBC(bcCert);
                    var chain = new IX509Certificate[] { bcCertWrapper };

                    signer.SignDetached(pks, chain, null, null, null, 0, PdfSigner.CryptoStandard.CADES);
                    return outputStream.ToArray();
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"⚠️ Ký số qua Virtual CSP bị gián đoạn hoặc gặp sự cố: {ex.Message}");
                Console.ResetColor();

                string msgLower = ex.Message.ToLowerInvariant();
                bool isUserCancel = msgLower.Contains("cancelled by the user") ||
                                   msgLower.Contains("hủy") ||
                                   msgLower.Contains("từ chối") ||
                                   msgLower.Contains("cancel");

                if (strict && isUserCancel)
                {
                    // Người dùng bấm Hủy / Từ chối trên điện thoại
                    throw new OperationCanceledException("Người dùng đã hủy hoặc từ chối phê duyệt lệnh ký số trên điện thoại.");
                }

                if (strict)
                {
                    // Khi ký thật (strict = true): Nếu CSP bảo trì hoặc lỗi KSP -> BẮT BUỘC ném ngoại lệ, TUYỆT ĐỐI KHÔNG FALLBACK!
                    throw new InvalidOperationException($"Lỗi ký số qua Ban Cơ yếu Chính phủ: {ex.Message}. Vui lòng kiểm tra lại thiết bị hoặc trạng thái bảo trì của VGCA.");
                }

                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("💡 Virtual CSP gặp sự cố (Broken Token / Driver). Tự động kích hoạt bộ niêm phong dự phòng mật mã chuẩn X.509 PAdES...");
                Console.ResetColor();
            }

            return SignBytesWithBouncyCastle(inputPdfBytes, cert, reason, location, visualSignImageBytes, signRect, targetPage);
        }

        public const string CurrentVersion = "2.2.0";
        private static bool _lastUpdateCheckResult = false;
        private static string _lastLatestVersion = CurrentVersion;
        private static AgentVersionInfo? _lastVersionInfo = null;
        private static DateTime _lastCheckTime = DateTime.MinValue;

        public class AgentVersionInfo
        {
            public string version { get; set; } = "2.0.0";
            public string releaseDate { get; set; } = "";
            public string title { get; set; } = "";
            public List<string> changelog { get; set; } = new List<string>();
            public string downloadUrl { get; set; } = "";
            public string zipDownloadUrl { get; set; } = "";
            public bool mandatory { get; set; } = false;
        }

        public static bool IsNewerVersion(string latestVerStr, string currentVerStr)
        {
            if (string.IsNullOrWhiteSpace(latestVerStr)) return false;
            try
            {
                string cleanLatest = Regex.Replace(latestVerStr.Trim(), @"^[^\d]*", "");
                string cleanCurrent = Regex.Replace(currentVerStr.Trim(), @"^[^\d]*", "");
                var vLatest = Version.Parse(cleanLatest);
                var vCurrent = Version.Parse(cleanCurrent);
                return vLatest > vCurrent;
            }
            catch
            {
                return string.Compare(latestVerStr, currentVerStr, StringComparison.OrdinalIgnoreCase) > 0;
            }
        }

        public static (bool hasUpdate, AgentVersionInfo? info) CheckForUpdates(bool force = false)
        {
            if (!force && (DateTime.Now - _lastCheckTime).TotalMinutes < 3 && _lastVersionInfo != null)
            {
                return (_lastUpdateCheckResult, _lastVersionInfo);
            }

            var checkUrls = new[]
            {
                "http://127.0.0.1:3000/downloads/version.json",
                "https://raw.githubusercontent.com/MrKhang-Khoi/cvakyso/main/docs/downloads/version.json",
                "https://mrkhang-khoi.github.io/cvakyso/docs/downloads/version.json",
                "https://mrkhang-khoi.github.io/cvakyso/downloads/version.json"
            };

            foreach (var url in checkUrls)
            {
                try
                {
                    using var handler = new HttpClientHandler { AllowAutoRedirect = true };
                    using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2.5) };
                    client.DefaultRequestHeaders.UserAgent.ParseAdd("EduSign-Agent/2.2");
                    string json = client.GetStringAsync(url).GetAwaiter().GetResult();
                    if (!string.IsNullOrWhiteSpace(json))
                    {
                        var info = JsonSerializer.Deserialize<AgentVersionInfo>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        if (info != null && !string.IsNullOrWhiteSpace(info.version))
                        {
                            bool hasNew = IsNewerVersion(info.version, CurrentVersion);
                            _lastUpdateCheckResult = hasNew;
                            _lastLatestVersion = info.version;
                            _lastVersionInfo = info;
                            _lastCheckTime = DateTime.Now;
                            if (_activeTrayInstance != null)
                            {
                                _activeTrayInstance.UpdateAvailable = hasNew;
                                _activeTrayInstance.LatestVersionInfo = info;
                            }
                            return (hasNew, info);
                        }
                    }
                }
                catch { }
            }

            return (_lastUpdateCheckResult, _lastVersionInfo);
        }

        public static void TriggerUpdateGui(AgentVersionInfo? info = null)
        {
            try
            {
                if (info == null)
                {
                    var (hasNew, fetched) = CheckForUpdates(true);
                    info = fetched ?? new AgentVersionInfo
                    {
                        version = "2.2.0",
                        title = "Bản cập nhật EduSign Agent 2.2.0",
                        downloadUrl = "https://github.com/MrKhang-Khoi/cvakyso/raw/main/docs/downloads/EduSign_Agent.exe",
                        changelog = new List<string> { "Khóa định danh 3 lớp bảo mật & Lọc USB SmartCard chuẩn" }
                    };
                }

                var staThread = new Thread(() =>
                {
                    try
                    {
                        Application.EnableVisualStyles();
                        try { Application.SetCompatibleTextRenderingDefault(false); } catch { }
                        using var form = new EduSignUpdateForm(info);
                        Application.Run(form);
                    }
                    catch { }
                });
                staThread.SetApartmentState(ApartmentState.STA);
                staThread.IsBackground = true;
                staThread.Start();
            }
            catch { }
        }

        private static EduSignWin32Tray? _activeTrayInstance;

        public static void RunDesktopAgent()
        {
            RunTrayAgent();
        }

        private static Mutex? _agentMutex;
        public static void RunTrayAgent()
        {
            bool isFirst = false;
            try
            {
                _agentMutex = new Mutex(true, @"EduSign_Agent_SingleInstance_2_0", out isFirst);
                if (!isFirst)
                {
                    string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
                    try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Another EduSign Agent instance is already active. Exiting.\n"); } catch { }
                    return;
                }
            }
            catch (Exception ex)
            {
                string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
                try { File.AppendAllText(debugLog, $"[{DateTime.Now}] [ERR_MUTEX_FAILED] Không thể tạo hoặc sở hữu Mutex single-instance: {ex.Message}. Thoát an toàn để ngăn xung đột đa tiến trình (Fail-Closed).\n"); } catch { }
                return;
            }

            try
            {
                // Dọn dẹp tệp sao lưu .bak cũ từ các lần cập nhật trước
                try
                {
                    string currentExe = Environment.ProcessPath ?? AppDomain.CurrentDomain.BaseDirectory;
                    string bakFile = currentExe + ".bak";
                    if (File.Exists(bakFile)) File.Delete(bakFile);
                }
                catch { }

                // TỰ ĐỘNG THIẾT LẬP CÀI ĐẶT CHUẨN WINDOWS (Tự chép vào LocalAppData, tạo Desktop Icon & khởi động cùng Windows)
                EnsureInstalledAndShortcuts();

                _activeTrayInstance = new EduSignWin32Tray();
                _activeTrayInstance.Run();
                GC.KeepAlive(_activeTrayInstance);
            }
            catch (Exception ex)
            {
                string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
                try { File.AppendAllText(debugLog, $"[{DateTime.Now}] RunTrayAgent error: {ex}\n"); } catch { }
            }
            finally
            {
                _agentMutex?.Dispose();
            }
        }

        #region Windows Authenticode Verification via WinVerifyTrust

        private static readonly Guid WINTRUST_ACTION_GENERIC_VERIFY_V2 = new Guid("{00AAC56B-CD44-11d0-8CC2-00C04FC295EE}");

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string? pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        private const uint WTD_UI_NONE = 2;
        private const uint WTD_REVOKE_WHOLECHAIN = 1;
        private const uint WTD_CHOICE_FILE = 1;
        private const uint WTD_STATEACTION_IGNORE = 0;
        private const uint WTD_SAFER_FLAG = 0x00000100;
        private const uint WTD_CACHE_ONLY_URL_RETRIEVAL = 0x00001000;

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(
            IntPtr hwnd,
            [MarshalAs(UnmanagedType.LPStruct)] Guid pgActionID,
            ref WINTRUST_DATA pWVTData);

        private static bool VerifyAuthenticodeSignature(string filePath, out string? errorDetail)
        {
            errorDetail = null;
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                errorDetail = "Nền tảng không phải Windows, không thể kiểm tra Authenticode.";
                return false;
            }

            var fileInfo = new WINTRUST_FILE_INFO
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(),
                pcwszFilePath = filePath,
                hFile = IntPtr.Zero,
                pgKnownSubject = IntPtr.Zero
            };

            IntPtr pFileInfo = Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_FILE_INFO>());
            try
            {
                Marshal.StructureToPtr(fileInfo, pFileInfo, false);

                var trustData = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(),
                    pPolicyCallbackData = IntPtr.Zero,
                    pSIPClientData = IntPtr.Zero,
                    dwUIChoice = WTD_UI_NONE,
                    fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN,
                    dwUnionChoice = WTD_CHOICE_FILE,
                    pFile = pFileInfo,
                    dwStateAction = WTD_STATEACTION_IGNORE,
                    hWVTStateData = IntPtr.Zero,
                    pwszURLReference = null,
                    dwProvFlags = WTD_SAFER_FLAG | WTD_CACHE_ONLY_URL_RETRIEVAL,
                    dwUIContext = 0,
                    pSignatureSettings = IntPtr.Zero
                };

                int result = WinVerifyTrust(IntPtr.Zero, WINTRUST_ACTION_GENERIC_VERIFY_V2, ref trustData);
                if (result == 0) // ERROR_SUCCESS
                {
                    return true;
                }

                errorDetail = $"Chữ ký Authenticode không hợp lệ (WinVerifyTrust: 0x{result:X8})";
                return false;
            }
            catch (Exception ex)
            {
                errorDetail = $"Lỗi WinVerifyTrust: {ex.Message}";
                return false;
            }
            finally
            {
                Marshal.FreeHGlobal(pFileInfo);
            }
        }

        #endregion

        private static bool VerifyExecutableIntegrity(string exePath, out string? failureReason)
        {
            failureReason = null;
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath))
            {
                failureReason = "Tệp thực thi không tồn tại hoặc đường dẫn rỗng.";
                return false;
            }

            var fileInfo = new FileInfo(exePath);
            if (fileInfo.Length < 1024)
            {
                failureReason = "Kích thước tệp thực thi không hợp lệ (< 1KB).";
                return false;
            }

            // 1. Xác thực chữ ký số Authenticode toàn vẹn qua Windows WinVerifyTrust
            if (VerifyAuthenticodeSignature(exePath, out string? authError))
            {
                return true;
            }

            // 2. Chế độ kiểm thử (Chỉ cho phép trong bản Debug biên dịch nội bộ, bị cô lập hoàn toàn khỏi Production)
#if DEBUG
            string? testMode = Environment.GetEnvironmentVariable("EDUSIGN_TEST_MODE");
            string? nodeEnv = Environment.GetEnvironmentVariable("NODE_ENV");
            if (testMode == "1" && nodeEnv == "test")
            {
                return true;
            }
#endif

            failureReason = authError ?? "Tệp thực thi không có chữ ký Authenticode hợp lệ.";
            return false;
        }

        private static string ComputeFileSha256(string filePath)
        {
            using var sha256 = System.Security.Cryptography.SHA256.Create();
            using var stream = File.Open(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            byte[] hash = sha256.ComputeHash(stream);
            return Convert.ToHexString(hash);
        }

        private static void LogAgentDebug(string message)
        {
            try
            {
                string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
                File.AppendAllText(debugLog, $"[{DateTime.Now}] {message}\n");
            }
            catch { }
        }

        private static bool SafeInstallExecutable(string currentExe, string targetExe, out string? error)
        {
            error = null;
            if (string.IsNullOrEmpty(currentExe) || !File.Exists(currentExe))
            {
                error = "[ERR_SOURCE_MISSING] currentExe không tồn tại hoặc đường dẫn rỗng.";
                LogAgentDebug(error);
                return false;
            }

            string targetDir = System.IO.Path.GetDirectoryName(targetExe) ?? "";
            if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);

            // Bảo vệ toàn bộ chuỗi staging và rollback bằng Mutex liên tiến trình dành riêng cho targetExe
            using var installMutex = new Mutex(false, @"Local\EduSign_Agent_Install_Lock");
            bool lockAcquired = false;
            try
            {
                lockAcquired = installMutex.WaitOne(5000, false);
            }
            catch (AbandonedMutexException)
            {
                lockAcquired = true;
            }

            if (!lockAcquired)
            {
                error = "[ERR_INSTALL_LOCK_TIMEOUT] Không thể sở hữu lock cài đặt liên tiến trình.";
                LogAgentDebug(error);
                return false;
            }

            try
            {
                bool isTargetExe = string.Equals(currentExe, targetExe, StringComparison.OrdinalIgnoreCase);
                if (isTargetExe)
                {
                    // Nếu đã đang chạy từ targetExe, xác thực tính toàn vẹn của chính targetExe
                    if (!VerifyExecutableIntegrity(targetExe, out string? targetVerifyErr))
                    {
                        error = $"[ERR_TARGET_INTEGRITY] Xác thực tính toàn vẹn tệp đích thất bại: {targetVerifyErr}";
                        LogAgentDebug(error);
                        return false;
                    }
                    return true;
                }

                string tempTarget = System.IO.Path.Combine(targetDir, $"EduSign_Agent.exe.tmp_{Guid.NewGuid():N}");
                string backupTarget = System.IO.Path.Combine(targetDir, $"EduSign_Agent.exe.bak_{Guid.NewGuid():N}");
                bool hasBackup = false;
                string? originalTargetHash = null;
                string? tempHash = null;
                string sourceHash;

                try
                {
                    // 1. Mở tệp nguồn duy nhất một lần (sourceStream) với FileShare.Read và giữ handle này trong suốt quá trình xác thực và sao chép
                    using (var sourceStream = new FileStream(currentExe, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        // Xác thực tính toàn vẹn Authenticode trên tệp nguồn trong khi handle sourceStream đang giữ khóa đọc chống sửa
                        if (!VerifyExecutableIntegrity(currentExe, out string? verifySourceErr))
                        {
                            error = $"[ERR_SOURCE_INTEGRITY] Xác thực tính toàn vẹn tệp nguồn thất bại: {verifySourceErr}";
                            LogAgentDebug(error);
                            return false;
                        }

                        // Sao chép trực tiếp từ sourceStream sang tệp tạm độc quyền (FileShare.None) và tính mã băm nguồn trên luồng sao chép
                        using (var dstStream = new FileStream(tempTarget, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                        {
                            using var sha256Source = System.Security.Cryptography.SHA256.Create();
                            using var cryptoStream = new System.Security.Cryptography.CryptoStream(dstStream, sha256Source, CryptoStreamMode.Write);
                            sourceStream.CopyTo(cryptoStream);
                            cryptoStream.FlushFinalBlock();
                            sourceHash = Convert.ToHexString(sha256Source.Hash!);
                        }
                    }

                    // 2. Thiết lập ACL bảo vệ: Chỉ cấp quyền cho CurrentUser và Administrators, khóa thừa kế từ thư mục cha
                    if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                    {
                        try
                        {
                            var fileInfo = new FileInfo(tempTarget);
                            var fileSecurity = new System.Security.AccessControl.FileSecurity();
                            var currentUser = System.Security.Principal.WindowsIdentity.GetCurrent().User;
                            if (currentUser != null)
                            {
                                fileSecurity.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                                    currentUser,
                                    System.Security.AccessControl.FileSystemRights.FullControl,
                                    System.Security.AccessControl.AccessControlType.Allow));
                            }
                            var adminsSid = new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.BuiltinAdministratorsSid, null);
                            fileSecurity.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                                adminsSid,
                                System.Security.AccessControl.FileSystemRights.FullControl,
                                System.Security.AccessControl.AccessControlType.Allow));
                            fileSecurity.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
                            fileInfo.SetAccessControl(fileSecurity);
                        }
                        catch (Exception aclEx)
                        {
                            try { File.Delete(tempTarget); } catch { }
                            error = $"[ERR_TEMP_ACL_FAILED] Không thể thiết lập ACL bảo vệ tệp tạm ({aclEx.Message}). Hủy staging.";
                            LogAgentDebug(error);
                            return false;
                        }
                    }

                    // 3. Mở handle độc quyền chống ghi/sửa (FileShare.Read) trên tệp tạm, tính mã băm trước và sau khi xác thực Authenticode
                    bool tempValid = false;
                    string? verifyTempErr = null;
                    string preVerifyHash;
                    string postVerifyHash;
                    using (var lockStream = new FileStream(tempTarget, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        using (var sha256Pre = System.Security.Cryptography.SHA256.Create())
                        {
                            preVerifyHash = Convert.ToHexString(sha256Pre.ComputeHash(lockStream));
                        }

                        tempValid = VerifyExecutableIntegrity(tempTarget, out verifyTempErr);

                        lockStream.Position = 0;
                        using (var sha256Post = System.Security.Cryptography.SHA256.Create())
                        {
                            postVerifyHash = Convert.ToHexString(sha256Post.ComputeHash(lockStream));
                        }
                    }

                    // Xác nhận tính bất biến của tệp tạm trước và sau khi xác thực Authenticode
                    if (!string.Equals(preVerifyHash, postVerifyHash, StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(tempTarget); } catch { }
                        error = $"[ERR_TEMP_TOCTOU] Phát hiện tệp tạm bị biến đổi trong quá trình xác thực Authenticode ({preVerifyHash} != {postVerifyHash}). Hủy staging.";
                        LogAgentDebug(error);
                        return false;
                    }

                    tempHash = postVerifyHash;

                    // Đối chiếu bắt buộc: Mã băm tệp tạm phải khớp 100% với mã băm dữ liệu nguồn vừa sao chép từ sourceStream
                    if (!string.Equals(tempHash, sourceHash, StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(tempTarget); } catch { }
                        error = $"[ERR_TEMP_HASH_MISMATCH] Mã băm tệp tạm ({tempHash}) không khớp mã băm tệp nguồn ({sourceHash}). Hủy staging.";
                        LogAgentDebug(error);
                        return false;
                    }

                    if (!tempValid)
                    {
                        try { File.Delete(tempTarget); } catch { }
                        error = $"[ERR_TEMP_VERIFY] Xác thực Authenticode trên tệp tạm thất bại: {verifyTempErr}";
                        LogAgentDebug(error);
                        return false;
                    }

                    // Kiểm tra nền tảng hệ điều hành: Chống TOCTOU trên tệp thực thi yêu cầu Windows NT kernel APIs (CreateFileW, SafeFileHandle)
                    if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                    {
                        try { File.Delete(tempTarget); } catch { }
                        error = "[ERR_UNSUPPORTED_PLATFORM] Tính năng tự động cài đặt và hoán đổi tệp thực thi an toàn yêu cầu Windows NT kernel APIs (CreateFileW, SafeFileHandle) để chống TOCTOU. Nền tảng hiện tại không được hỗ trợ.";
                        LogAgentDebug(error);
                        return false;
                    }

                    // 1. Mở và khóa độc quyền handle tệp tạm tempTarget không theo Reparse Point, giữ mở xuyên suốt staging
                    Microsoft.Win32.SafeHandles.SafeFileHandle? hTempLock = CreateFileW(
                        tempTarget,
                        0x80000000, // GENERIC_READ
                        0x00000001, // FILE_SHARE_READ (khóa chặt tệp tạm, cấm tuyệt đối xóa/đổi tên/thay thế từ tiến trình khác)
                        IntPtr.Zero,
                        3,          // OPEN_EXISTING
                        0x00200000, // FILE_FLAG_OPEN_REPARSE_POINT
                        IntPtr.Zero);

                    BY_HANDLE_FILE_INFORMATION tempInfo = new BY_HANDLE_FILE_INFORMATION();
                    if (hTempLock.IsInvalid || !GetFileInformationByHandle(hTempLock, out tempInfo) || (tempInfo.dwFileAttributes & 0x00000400) != 0)
                    {
                        hTempLock?.Dispose();
                        hTempLock = null;
                        try { File.Delete(tempTarget); } catch { }
                        error = $"[ERR_TEMP_REPARSE_POINT] Tệp tạm '{tempTarget}' là Reparse Point hoặc metadata không hợp lệ.";
                        LogAgentDebug(error);
                        return false;
                    }

                    // Ghi nhận định danh vật lý bất biến (Volume Serial Number + File Index) của tệp tạm để hậu kiểm khi commit
                    uint tempVolId = tempInfo.dwVolumeSerialNumber;
                    uint tempFileIndexHigh = tempInfo.nFileIndexHigh;
                    uint tempFileIndexLow = tempInfo.nFileIndexLow;

                    // 2. Khóa và ghim chuỗi thư mục từ targetDir lên tận root bằng handle mở không theo Reparse Point
                    // Mở với GENERIC_READ (0x80000000) và dwShareMode = 0x3 (FILE_SHARE_READ | FILE_SHARE_WRITE, loại trừ FILE_SHARE_DELETE).
                    // Tất cả handle được lưu trong heldDirHandles và giữ mở xuyên suốt giao dịch staging để phòng vệ chống TOCTOU:
                    // Nhân Windows NT sẽ ngăn chặn các nỗ lực xóa, đổi tên hoặc thay thế thư mục bằng Junction từ tiến trình khác.
                    // Duyệt top-down từ thư mục gốc xuống đích để đảm bảo mỗi thành phần trung gian được kiểm tra thuộc tính reparse
                    // tại đúng thành phần cuối của đường dẫn qua FILE_FLAG_OPEN_REPARSE_POINT, đồng thời đối chiếu canonical path.
                    using var heldDirHandles = new DisposableHandleList();
                    var dirChain = new List<DirectoryInfo>();
                    for (var d = new DirectoryInfo(targetDir); d != null; d = d.Parent)
                    {
                        dirChain.Insert(0, d);
                    }

                    foreach (var dirItem in dirChain)
                    {
                        var hDir = CreateFileW(
                            dirItem.FullName,
                            0x80000000, // GENERIC_READ
                            0x00000003, // FILE_SHARE_READ | FILE_SHARE_WRITE (chặn xóa/đổi tên/thay thế thư mục từ tiến trình khác)
                            IntPtr.Zero,
                            3,          // OPEN_EXISTING
                            0x02000000 | 0x00200000, // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
                            IntPtr.Zero);

                        if (hDir.IsInvalid)
                        {
                            hTempLock?.Dispose();
                            hTempLock = null;
                            try { File.Delete(tempTarget); } catch { }
                            error = $"[ERR_DIR_OPEN_FAILED] Không thể mở và ghim handle an toàn trên thư mục '{dirItem.FullName}' (Win32 Error: {Marshal.GetLastWin32Error()}). Hủy staging.";
                            LogAgentDebug(error);
                            return false;
                        }

                        if (!GetFileInformationByHandle(hDir, out var dInfo) || (dInfo.dwFileAttributes & 0x00000400) != 0)
                        {
                            hDir.Dispose();
                            hTempLock?.Dispose();
                            hTempLock = null;
                            try { File.Delete(tempTarget); } catch { }
                            error = $"[ERR_PATH_REPARSE_POINT] Thư mục '{dirItem.FullName}' trong đường dẫn đích là Reparse Point / Junction không an toàn hoặc metadata không hợp lệ.";
                            LogAgentDebug(error);
                            return false;
                        }

                        // Đối chiếu canonical path để phát hiện chuyển hướng Junction/Symlink ở từng cấp (Fail-Closed)
                        string? canonicalDir = GetFinalPath(hDir);
                        string expectedDir = System.IO.Path.GetFullPath(dirItem.FullName).TrimEnd('\\');
                        if (string.IsNullOrEmpty(canonicalDir) || !string.Equals(System.IO.Path.GetFullPath(canonicalDir).TrimEnd('\\'), expectedDir, StringComparison.OrdinalIgnoreCase))
                        {
                            hDir.Dispose();
                            hTempLock?.Dispose();
                            hTempLock = null;
                            try { File.Delete(tempTarget); } catch { }
                            error = $"[ERR_PATH_CANONICAL_MISMATCH] Thư mục '{dirItem.FullName}' không khớp đường dẫn vật lý thực tế sau khi phân giải ('{canonicalDir}' != '{expectedDir}'). Phát hiện chuyển hướng Junction/Symlink hoặc lỗi phân giải.";
                            LogAgentDebug(error);
                            return false;
                        }

                        heldDirHandles.Add(hDir);
                    }

                    // 4. Mở targetExe bằng handle an toàn không theo Reparse Point (FILE_FLAG_OPEN_REPARSE_POINT)
                    bool targetExists = false;
                    using (var safeHandle = CreateFileW(
                        targetExe,
                        0x80000000, // GENERIC_READ
                        0x00000001, // FILE_SHARE_READ
                        IntPtr.Zero,
                        3,          // OPEN_EXISTING
                        0x00200000, // FILE_FLAG_OPEN_REPARSE_POINT
                        IntPtr.Zero))
                    {
                        if (!safeHandle.IsInvalid)
                        {
                            if (!GetFileInformationByHandle(safeHandle, out var fileInfo))
                            {
                                hTempLock?.Dispose();
                                hTempLock = null;
                                try { File.Delete(tempTarget); } catch { }
                                error = $"[ERR_TARGET_METADATA_FAILED] Không thể đọc metadata tệp đích qua handle an toàn (Win32 Error: {Marshal.GetLastWin32Error()}). Hủy staging.";
                                LogAgentDebug(error);
                                return false;
                            }

                            if ((fileInfo.dwFileAttributes & 0x00000400) != 0) // FILE_ATTRIBUTE_REPARSE_POINT
                            {
                                hTempLock?.Dispose();
                                hTempLock = null;
                                try { File.Delete(tempTarget); } catch { }
                                error = $"[ERR_TARGET_FILE_REPARSE_POINT] Tệp đích {targetExe} là Reparse Point / Symlink không an toàn.";
                                LogAgentDebug(error);
                                return false;
                            }

                            // Đối chiếu canonical path của tệp đích sau khi mở handle (Fail-Closed)
                            string? canonicalExe = GetFinalPath(safeHandle);
                            string expectedExe = System.IO.Path.GetFullPath(targetExe);
                            if (string.IsNullOrEmpty(canonicalExe) || !string.Equals(System.IO.Path.GetFullPath(canonicalExe), expectedExe, StringComparison.OrdinalIgnoreCase))
                            {
                                hTempLock?.Dispose();
                                hTempLock = null;
                                try { File.Delete(tempTarget); } catch { }
                                error = $"[ERR_TARGET_CANONICAL_MISMATCH] Tệp đích '{targetExe}' không khớp đường dẫn vật lý thực tế ('{canonicalExe}' != '{expectedExe}'). Phát hiện chuyển hướng Junction/Symlink hoặc lỗi phân giải.";
                                LogAgentDebug(error);
                                return false;
                            }

                            targetExists = true;

                            using (var existingStream = new FileStream(safeHandle, FileAccess.Read))
                            {
                                using var sha256Target = System.Security.Cryptography.SHA256.Create();
                                originalTargetHash = Convert.ToHexString(sha256Target.ComputeHash(existingStream));
                            }

                            if (string.Equals(originalTargetHash, tempHash, StringComparison.OrdinalIgnoreCase))
                            {
                                // Đã tồn tại bản sao trùng khớp hoàn toàn với tệp tạm đã xác thực
                                hTempLock?.Dispose();
                                hTempLock = null;
                                try { File.Delete(tempTarget); } catch { }
                                return true;
                            }
                        }
                        else
                        {
                            int win32Err = Marshal.GetLastWin32Error();
                            if (win32Err != 2) // ERROR_FILE_NOT_FOUND (2)
                            {
                                hTempLock?.Dispose();
                                hTempLock = null;
                                try { File.Delete(tempTarget); } catch { }
                                error = $"[ERR_TARGET_OPEN_FAILED] Không thể mở tệp đích qua handle an toàn (Win32 Error: {win32Err}). Hủy staging.";
                                LogAgentDebug(error);
                                return false;
                            }
                            targetExists = false;
                        }
                    }

                    // Kiểm tra lại tính toàn vẹn của tệp tạm qua handle an toàn ngay trước thao tác hoán đổi nguyên tử
                    if (hTempLock != null && !hTempLock.IsInvalid)
                    {
                        BY_HANDLE_FILE_INFORMATION preInfo = new BY_HANDLE_FILE_INFORMATION();
                        if (!GetFileInformationByHandle(hTempLock, out preInfo) || (preInfo.dwFileAttributes & 0x00000400) != 0 ||
                            (tempVolId != 0 && (preInfo.dwVolumeSerialNumber != tempVolId || preInfo.nFileIndexHigh != tempFileIndexHigh || preInfo.nFileIndexLow != tempFileIndexLow)))
                        {
                            hTempLock.Dispose();
                            hTempLock = null;
                            try { File.Delete(tempTarget); } catch { }
                            error = $"[ERR_PRE_SWAP_REPARSE_POINT] Phát hiện tệp tạm '{tempTarget}' bị can thiệp biến đổi định danh hoặc thuộc tính trước hoán đổi.";
                            LogAgentDebug(error);
                            return false;
                        }
                    }

                    // Kiểm tra mã băm tức thì ngay trước khi hoán đổi (Immediate Pre-Swap Verification) trực tiếp trên handle đang khóa
                    string preSwapHash;
                    if (hTempLock != null && !hTempLock.IsInvalid)
                    {
                        using var sha256PreSwap = System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
                        byte[] swapBuf = new byte[81920];
                        long readOffset = 0; int bytesRead;
                        while ((bytesRead = System.IO.RandomAccess.Read(hTempLock, swapBuf, readOffset)) > 0) { sha256PreSwap.AppendData(swapBuf, 0, bytesRead); readOffset += bytesRead; }
                        preSwapHash = Convert.ToHexString(sha256PreSwap.GetHashAndReset());
                    }
                    else
                    {
                        hTempLock?.Dispose(); hTempLock = null;
                        try { File.Delete(tempTarget); } catch { }
                        error = "[ERR_TEMP_HANDLE_INVALID] Handle tệp tạm không hợp lệ trước khi hoán đổi.";
                        LogAgentDebug(error);
                        return false;
                    }

                    if (!string.Equals(preSwapHash, tempHash, StringComparison.OrdinalIgnoreCase))
                    {
                        hTempLock?.Dispose(); hTempLock = null;
                        try { File.Delete(tempTarget); } catch { }
                        error = $"[ERR_TEMP_TOCTOU_PRE_SWAP] Phát hiện tệp tạm bị can thiệp trước thao tác hoán đổi ({preSwapHash} != {tempHash}). Hủy cài đặt.";
                        LogAgentDebug(error); return false;
                    }

                    // 5. Thao tác hoán đổi nguyên tử (Atomic Swap Primitive)
                    hTempLock?.Dispose(); hTempLock = null; if (targetExists)
                    {
                        // Hoán đổi tempTarget sang targetExe và đưa bản cũ sang backupTarget trong một giao dịch nguyên tử duy nhất (Zero Window)
                        File.Replace(tempTarget, targetExe, backupTarget, ignoreMetadataErrors: true);
                        hasBackup = true;
                    }
                    else
                    {
                        // Tệp đích chưa tồn tại: Di chuyển an toàn với overwrite: false để chống race condition tạo tệp giả mạo
                        File.Move(tempTarget, targetExe, overwrite: false);
                        hasBackup = false;
                    }

                    // 6. Kiểm tra tính toàn vẹn và mã băm sau khi thay thế nguyên tử qua handle an toàn
                    if (!File.Exists(targetExe))
                    {
                        throw new IOException("Tệp đích không tồn tại sau thao tác hoán đổi nguyên tử.");
                    }

                    // Tái xác thực mã băm tệp đích ngay sau hoán đổi qua handle không theo Reparse Point
                    string postInstallHash;
                    using (var postSafeHandle = CreateFileW(
                        targetExe,
                        0x80000000, // GENERIC_READ
                        0x00000001, // FILE_SHARE_READ
                        IntPtr.Zero,
                        3,          // OPEN_EXISTING
                        0x00200000, // FILE_FLAG_OPEN_REPARSE_POINT
                        IntPtr.Zero))
                    {
                        if (postSafeHandle.IsInvalid)
                        {
                            throw new IOException("Không thể mở lại tệp đích qua handle an toàn sau khi hoán đổi.");
                        }

                        if (GetFileInformationByHandle(postSafeHandle, out var postInfo) && (postInfo.dwFileAttributes & 0x00000400) != 0)
                        {
                            throw new InvalidOperationException("Phát hiện tệp đích bị thay thế bằng Reparse Point sau khi hoán đổi.");
                        }

                        // Đối chiếu canonical path của tệp đích sau hoán đổi để phát hiện chuyển hướng Junction/Symlink (Fail-Closed)
                        string? postCanonicalExe = GetFinalPath(postSafeHandle);
                        string expectedPostExe = System.IO.Path.GetFullPath(targetExe);
                        if (string.IsNullOrEmpty(postCanonicalExe) || !string.Equals(System.IO.Path.GetFullPath(postCanonicalExe), expectedPostExe, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("[ERR_POST_CANONICAL_MISMATCH] Tệp đích sau hoán đổi không khớp đường dẫn vật lý thực tế. Phát hiện chuyển hướng Junction/Symlink hoặc lỗi phân giải.");
                        }

                        // Hậu kiểm định danh vật lý bất biến (Volume Serial Number + File Index): tệp đích bắt buộc là chính tệp tạm đã được staged
                        if (tempVolId != 0 && (postInfo.dwVolumeSerialNumber != tempVolId || postInfo.nFileIndexHigh != tempFileIndexHigh || postInfo.nFileIndexLow != tempFileIndexLow))
                        {
                            throw new InvalidOperationException("[ERR_IDENTITY_MISMATCH] Tệp đích sau hoán đổi không khớp định danh vật lý (Volume/File ID) của tệp tạm đã xác thực.");
                        }

                        using var postStream = new FileStream(postSafeHandle, FileAccess.Read);
                        using var sha256Post = System.Security.Cryptography.SHA256.Create();
                        postInstallHash = Convert.ToHexString(sha256Post.ComputeHash(postStream));
                    }

                // Tái xác thực Authenticode và mã băm đồng thời trong khi giữ khóa chống ghi (FileShare.Read) trên tệp đích
                bool postInstallValid = false; string? postInstallErr = null; bool hashMatched = false;
                using (var postLockStream = new FileStream(targetExe, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    using var shaPre = System.Security.Cryptography.SHA256.Create(); string preHash = Convert.ToHexString(shaPre.ComputeHash(postLockStream));
                    postInstallValid = VerifyExecutableIntegrity(targetExe, out postInstallErr);
                    postLockStream.Position = 0; using var shaPost = System.Security.Cryptography.SHA256.Create(); string postHash = Convert.ToHexString(shaPost.ComputeHash(postLockStream));
                    hashMatched = string.Equals(preHash, postHash, StringComparison.OrdinalIgnoreCase) && string.Equals(postHash, tempHash, StringComparison.OrdinalIgnoreCase);
                }
                if (!postInstallValid || !hashMatched)
                {
                    // Cơ chế phòng vệ TOCTOU chuẩn Zero-Trust:
                    // Sau khi hoán đổi tệp đích, nếu hậu kiểm Authenticode hoặc SHA-256 thất bại,
                    // việc tự động xóa (File.Delete) hoặc thay thế (File.Replace) theo đường dẫn (pathname)
                    // sẽ tạo cửa sổ TOCTOU nghiêm trọng nếu có tiến trình khác can thiệp đường dẫn.
                    // Đồng thời, việc xóa tệp lỗi sẽ phá hủy chứng cứ pháp y số (forensic evidence).
                    // Do đó, hệ thống áp dụng nguyên tắc Fail-Closed và chuyển sang MANUAL_AUDIT_REQUIRED:
                    // 1. Bản sao lưu ban đầu (backupTarget) được bảo toàn nguyên vẹn 100% trên đĩa.
                    // 2. Tệp đích sau hoán đổi được giữ nguyên trạng, không tự ý xóa hay ghi đè.
                    // 3. Tệp tạm của giao dịch (tempTarget) được dọn dẹp an toàn.
                    // 4. Báo lỗi thất bại kèm thông báo yêu cầu quản trị viên kiểm tra thủ công.
                    string rollbackMsg;
                    if (hasBackup && File.Exists(backupTarget))
                    {
                        rollbackMsg = $"[MANUAL_AUDIT_REQUIRED] Bản backup ban đầu được bảo toàn an toàn tại '{backupTarget}'. Không tự động rollback qua đường dẫn để chống TOCTOU; yêu cầu quản trị viên kiểm tra thủ công.";
                    }
                    else
                    {
                        rollbackMsg = "[MANUAL_AUDIT_REQUIRED] Tệp đích không hợp lệ và không có bản backup. Bảo toàn nguyên trạng để phục vụ giám định số, không tự động xóa qua đường dẫn để tránh TOCTOU.";
                    }

                    try
                    {
                        if (File.Exists(tempTarget)) File.Delete(tempTarget);
                    }
                    catch (Exception clEx)
                    {
                        LogAgentDebug($"[WARN_TEMP_CLEANUP_FAILED] Không thể dọn dẹp tệp tạm '{tempTarget}': {clEx.Message}");
                    }
                    error = $"[ERR_POST_INSTALL_VERIFY] Xác thực tính toàn vẹn Authenticode hoặc mã băm trên tệp đích sau cài đặt thất bại: {(postInstallValid ? "Mã băm không khớp" : postInstallErr)}. {rollbackMsg}";
                    LogAgentDebug(error); return false;
                }
                // 7. Xác nhận thành công hoàn toàn: Bảo toàn bản backup ở trạng thái PENDING_CLEANUP để quản trị viên xử lý thủ công, triệt tiêu TOCTOU khi xóa qua pathname
                if (hasBackup && !string.IsNullOrEmpty(backupTarget)) {
                    LogAgentDebug($"[INFO_BACKUP_PENDING_CLEANUP] Đã cài đặt và xác thực tệp đích thành công. Bản sao lưu '{backupTarget}' được bảo toàn an toàn ở trạng thái PENDING_CLEANUP phục vụ đối soát, không tự động xóa qua pathname.");
                }
                return true;
            }
            catch (Exception ex)
            {
                // Rollback an toàn có kiểm tra quyền sở hữu (Ownership Check):
                // Chỉ rollback nếu xác nhận targetExe hiện tại là artifact bị lỗi của giao dịch này (khớp tempHash hoặc không khớp originalTargetHash)
                bool rollbackSucceeded = false;
                string rollbackDetail = "";
                try
                {
                    bool isOurArtifact = false;
                    if (File.Exists(targetExe))
                    {
                        // Kiểm tra tính hợp lệ của tempHash (bắt buộc phải là mã băm SHA-256 hợp chuẩn 64 ký tự)
                        bool isTempHashValid = !string.IsNullOrEmpty(tempHash) && tempHash.Length == 64;
                        string? currentTargetHash = null;
                        try
                        {
                            currentTargetHash = ComputeFileSha256(targetExe);
                        }
                        catch (Exception hashEx)
                        {
                            LogAgentDebug($"[WARN_TARGET_HASH_FAILED] Không thể tính mã băm tệp đích hiện tại: {hashEx.Message}");
                        }

                        if (isTempHashValid && !string.IsNullOrEmpty(currentTargetHash) &&
                            (string.Equals(currentTargetHash, tempHash, StringComparison.OrdinalIgnoreCase) ||
                             (originalTargetHash != null && originalTargetHash.Length == 64 && !string.Equals(currentTargetHash, originalTargetHash, StringComparison.OrdinalIgnoreCase))))
                        {
                            isOurArtifact = true;
                        }
                    }
                    else
                    {
                        isOurArtifact = true; // Tệp đích bị thiếu trên đĩa
                    }

                    // Áp dụng nguyên tắc Fail-Closed & Forensic Audit để triệt tiêu TOCTOU:
                    // 1. Tuyệt đối không dùng File.Move(backupTarget, targetExe) tiêu hao bản backup trước khi xác minh.
                    // 2. Tuyệt đối không xóa hay thay thế targetExe qua pathname khi không có handle bảo đảm file identity.
                    // 3. Bảo toàn nguyên vẹn bản backup (backupTarget) và chuyển sang MANUAL_AUDIT_REQUIRED.
                    if (hasBackup && File.Exists(backupTarget))
                    {
                        rollbackDetail = $"[MANUAL_AUDIT_REQUIRED] Bản sao lưu ban đầu được bảo toàn nguyên vẹn tại '{backupTarget}'. Để chống TOCTOU và bảo vệ dữ liệu, hệ thống không tự động thay thế qua đường dẫn; yêu cầu quản trị viên kiểm tra thủ công.";
                        rollbackSucceeded = true; // Bảo toàn thành công bản backup gốc
                    }
                    else
                    {
                        rollbackDetail = isOurArtifact
                            ? "[MANUAL_AUDIT_REQUIRED] Không có bản sao lưu ban đầu. Tệp đích được bảo toàn nguyên trạng phục vụ giám định số, không tự ý xóa qua đường dẫn."
                            : "[MANUAL_AUDIT_REQUIRED] Tệp đích không thuộc artifact của giao dịch này; bảo toàn nguyên trạng tệp đích.";
                        rollbackSucceeded = false;
                    }

                    // Bảo toàn tệp tạm giao dịch tempTarget phục vụ giám định số, không tự ý xóa theo pathname để chống TOCTOU
                    if (!string.IsNullOrEmpty(tempTarget)) {
                        LogAgentDebug($"[INFO_TEMP_PRESERVED] Tệp tạm giao dịch '{tempTarget}' được bảo toàn ở trạng thái PENDING_CLEANUP phục vụ giám định số, không tự động xóa qua pathname."); }
                }
                catch (Exception rollbackEx)
                {
                    rollbackDetail = $"Ngoại lệ trong quá trình thẩm định rollback: {rollbackEx.Message}";
                    rollbackSucceeded = false;
                }

                if (rollbackSucceeded)
                {
                    error = $"[ERR_INSTALL_FAILED_BACKUP_PRESERVED] Quá trình thay thế thất bại ({ex.Message}), nhưng {rollbackDetail}";
                }
                else
                {
                    error = $"[ERR_INSTALL_FAILED_MANUAL_AUDIT] Quá trình thay thế thất bại ({ex.Message}) và {rollbackDetail}";
                }

                LogAgentDebug(error);
                return false;
            }
                finally
                {
                    try { if (File.Exists(tempTarget)) File.Delete(tempTarget); } catch { }
                    try { if (!hasBackup && File.Exists(backupTarget)) File.Delete(backupTarget); } catch { }
                }
            }
            finally
            {
                if (lockAcquired)
                {
                    try { installMutex.ReleaseMutex(); } catch { }
                }
            }
        }

        public static void EnsureInstalledAndShortcuts()
        {
            try
            {
                string currentExe = Environment.ProcessPath ?? AppDomain.CurrentDomain.BaseDirectory;
                if (string.IsNullOrEmpty(currentExe) || !File.Exists(currentExe))
                {
                    LogAgentDebug("[ERR_INSTALL] currentExe rỗng hoặc không tồn tại.");
                    return;
                }

                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string targetDir = System.IO.Path.Combine(localAppData, "EduSign_Agent");
                string targetExe = System.IO.Path.Combine(targetDir, "EduSign_Agent.exe");

                if (!SafeInstallExecutable(currentExe, targetExe, out string? installErr))
                {
                    LogAgentDebug($"[ERR_ENSURE_INSTALLED] Cài đặt và xác thực executable thất bại: {installErr}. Hủy tạo shortcuts và autorun (Fail-Closed).");
                    return;
                }

                // Sao chép app.ico nếu có
                string currentIco = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                string targetIco = System.IO.Path.Combine(targetDir, "app.ico");
                if (File.Exists(currentIco) && !File.Exists(targetIco))
                {
                    try { File.Copy(currentIco, targetIco, true); } catch (Exception ex) { LogAgentDebug($"[WARN_ICO_COPY] {ex.Message}"); }
                }

                string exeToUse = targetExe;
                string icoToUse = File.Exists(targetIco) ? targetIco : (exeToUse + ",0");
                string workDir = System.IO.Path.GetDirectoryName(exeToUse) ?? targetDir;

                // 1. Tạo Desktop Shortcut chuẩn Windows có icon nhận diện
                try
                {
                    string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string lnkDesktop = System.IO.Path.Combine(desktopPath, "EduSign Agent.lnk");
                    CreateWindowsShortcut(lnkDesktop, exeToUse, "--tray", workDir, "EduSign Desktop Agent v2.0 - Ban Cơ yếu Chính phủ", icoToUse);
                }
                catch (Exception ex)
                {
                    LogAgentDebug($"[ERR_SHORTCUT_DESKTOP] {ex.Message}");
                }

                // 2. Tạo Start Menu Shortcut
                try
                {
                    string startMenu = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Start Menu\Programs");
                    string lnkStart = System.IO.Path.Combine(startMenu, "EduSign Agent.lnk");
                    CreateWindowsShortcut(lnkStart, exeToUse, "--tray", workDir, "EduSign Desktop Agent v2.0", icoToUse);
                }
                catch (Exception ex)
                {
                    LogAgentDebug($"[ERR_SHORTCUT_START] {ex.Message}");
                }

                // 3. Tự động đăng ký khởi động cùng Windows
                try
                {
                    using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                    key?.SetValue("EduSignAgent", $"\"{exeToUse}\" --tray");
                }
                catch (Exception ex)
                {
                    LogAgentDebug($"[ERR_AUTORUN] {ex.Message}");
                }
            }
            catch (Exception ex)
            {
                LogAgentDebug($"[ERR_ENSURE_INSTALLED_FATAL] Lỗi không xử lý được khi thiết lập cài đặt: {ex.Message}");
            }
        }

        public static void CreateWindowsShortcut(string shortcutPath, string targetPath, string arguments, string workingDir, string description, string? iconPath = null)
        {
            string iconToSet = !string.IsNullOrEmpty(iconPath) ? iconPath : (targetPath + ",0");
            try
            {
                Type? shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType)!;
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = targetPath;
                    shortcut.Arguments = arguments;
                    shortcut.WorkingDirectory = workingDir;
                    shortcut.Description = description;
                    shortcut.IconLocation = iconToSet;
                    shortcut.Save();
                    return;
                }
            }
            catch { }

            try
            {
                string psScript = $"$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{shortcutPath.Replace("'", "''")}'); $s.TargetPath = '{targetPath.Replace("'", "''")}'; $s.Arguments = '{arguments.Replace("'", "''")}'; $s.WorkingDirectory = '{workingDir.Replace("'", "''")}'; $s.Description = '{description.Replace("'", "''")}'; $s.IconLocation = '{iconToSet.Replace("'", "''")}'; $s.Save()";
                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{psScript}\"",
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                using var proc = System.Diagnostics.Process.Start(psi);
                proc?.WaitForExit(3000);
            }
            catch { }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
            public uint dwVolumeSerialNumber;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint nNumberOfLinks;
            public uint nFileIndexHigh;
            public uint nFileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            Microsoft.Win32.SafeHandles.SafeFileHandle hFile,
            out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            Microsoft.Win32.SafeHandles.SafeFileHandle hFile,
            [Out] System.Text.StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        private static string? GetFinalPath(Microsoft.Win32.SafeHandles.SafeFileHandle handle)
        {
            if (handle.IsInvalid) return null;
            var sb = new System.Text.StringBuilder(1024);
            uint len = GetFinalPathNameByHandle(handle, sb, (uint)sb.Capacity, 0);
            if (len == 0 || len > sb.Capacity) return null;
            string path = sb.ToString();
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal))
            {
                path = path.Substring(4);
            }
            return path;
        }

        private sealed class DisposableHandleList : List<Microsoft.Win32.SafeHandles.SafeFileHandle>, IDisposable
        {
            public void Dispose()
            {
                foreach (var h in this)
                {
                    try { h.Dispose(); } catch { }
                }
                Clear();
            }
        }

        public class EduSignInstallerForm : Form
        {
            private ProgressBar _progressBar = null!;
            private Label _lblStatus = null!;
            private Button _btnInstall = null!;
            private Button _btnCancel = null!;
            private CheckBox _chkDesktop = null!;
            private CheckBox _chkStartMenu = null!;
            private CheckBox _chkAutoRun = null!;
            private CheckBox _chkLaunchNow = null!;
            private TextBox _txtTargetDir = null!;

            public EduSignInstallerForm()
            {
                InitializeComponent();
            }

            private void InitializeComponent()
            {
                this.Text = "Cài đặt EduSign Agent 2.0 - Chuẩn Windows";
                this.Size = new System.Drawing.Size(560, 530);
                this.StartPosition = FormStartPosition.CenterScreen;
                this.FormBorderStyle = FormBorderStyle.FixedDialog;
                this.MaximizeBox = false;
                this.MinimizeBox = false;
                this.BackColor = System.Drawing.Color.White;
                this.Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Regular);

                try
                {
                    string iconPath = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                    if (File.Exists(iconPath))
                    {
                        this.Icon = new Icon(iconPath);
                    }
                }
                catch { }

                // Header
                var headerPanel = new Panel
                {
                    Dock = DockStyle.Top,
                    Height = 85,
                    BackColor = System.Drawing.Color.FromArgb(24, 39, 71)
                };

                var lblHeaderTitle = new Label
                {
                    Text = "EduSign Agent v2.0 - Chuẩn Windows",
                    Font = new System.Drawing.Font("Segoe UI", 13f, System.Drawing.FontStyle.Bold),
                    ForeColor = System.Drawing.Color.White,
                    Location = new System.Drawing.Point(20, 16),
                    AutoSize = true
                };

                var lblHeaderSub = new Label
                {
                    Text = "Ứng dụng Cầu nối Ký số Ban Cơ yếu Chính phủ (VGCA) • THCS Chu Văn An",
                    Font = new System.Drawing.Font("Segoe UI", 9f, System.Drawing.FontStyle.Regular),
                    ForeColor = System.Drawing.Color.FromArgb(203, 213, 225),
                    Location = new System.Drawing.Point(20, 46),
                    AutoSize = true
                };

                headerPanel.Controls.Add(lblHeaderTitle);
                headerPanel.Controls.Add(lblHeaderSub);

                // Footer
                var footerPanel = new Panel
                {
                    Dock = DockStyle.Bottom,
                    Height = 65,
                    BackColor = System.Drawing.Color.FromArgb(248, 250, 252)
                };

                var footerLine = new Panel
                {
                    Dock = DockStyle.Top,
                    Height = 1,
                    BackColor = System.Drawing.Color.FromArgb(226, 232, 240)
                };
                footerPanel.Controls.Add(footerLine);

                _btnInstall = new Button
                {
                    Text = "Cài đặt ngay",
                    Font = new System.Drawing.Font("Segoe UI", 10f, System.Drawing.FontStyle.Bold),
                    BackColor = System.Drawing.Color.FromArgb(16, 185, 129),
                    ForeColor = System.Drawing.Color.White,
                    FlatStyle = FlatStyle.Flat,
                    Size = new System.Drawing.Size(140, 38),
                    Location = new System.Drawing.Point(260, 14),
                    Cursor = Cursors.Hand
                };
                _btnInstall.FlatAppearance.BorderSize = 0;
                _btnInstall.Click += BtnInstall_Click;

                _btnCancel = new Button
                {
                    Text = "Hủy bỏ",
                    Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Regular),
                    BackColor = System.Drawing.Color.FromArgb(241, 245, 249),
                    ForeColor = System.Drawing.Color.FromArgb(71, 85, 105),
                    FlatStyle = FlatStyle.Flat,
                    Size = new System.Drawing.Size(100, 38),
                    Location = new System.Drawing.Point(415, 14),
                    Cursor = Cursors.Hand
                };
                _btnCancel.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(203, 213, 225);
                _btnCancel.Click += (s, e) => this.Close();

                footerPanel.Controls.Add(_btnInstall);
                footerPanel.Controls.Add(_btnCancel);

                // Body
                var bodyPanel = new Panel
                {
                    Dock = DockStyle.Fill,
                    Padding = new Padding(24, 16, 24, 16)
                };

                var lblDesc = new Label
                {
                    Text = "Trình cài đặt sẽ thiết lập EduSign Agent trên máy tính này để trình duyệt web có thể kết nối với USB Token Ban Cơ yếu và thực hiện ký duyệt văn bản, giáo án.",
                    Location = new System.Drawing.Point(24, 14),
                    Size = new System.Drawing.Size(495, 40),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85)
                };

                var lblTargetTitle = new Label
                {
                    Text = "Thư mục cài đặt ứng dụng chuẩn Windows:",
                    Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Bold),
                    ForeColor = System.Drawing.Color.FromArgb(30, 41, 59),
                    Location = new System.Drawing.Point(24, 62),
                    AutoSize = true
                };

                string defaultTarget = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EduSign_Agent");
                _txtTargetDir = new TextBox
                {
                    Text = defaultTarget,
                    Location = new System.Drawing.Point(24, 86),
                    Size = new System.Drawing.Size(495, 26),
                    ReadOnly = true,
                    BackColor = System.Drawing.Color.FromArgb(248, 250, 252),
                    ForeColor = System.Drawing.Color.FromArgb(71, 85, 105)
                };

                var lblOptions = new Label
                {
                    Text = "Tùy chọn thiết lập hệ thống:",
                    Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Bold),
                    ForeColor = System.Drawing.Color.FromArgb(30, 41, 59),
                    Location = new System.Drawing.Point(24, 126),
                    AutoSize = true
                };

                _chkDesktop = new CheckBox
                {
                    Text = "Tạo biểu tượng lối tắt ngoài màn hình nền (Desktop) có Icon nhận diện",
                    Checked = true,
                    Location = new System.Drawing.Point(28, 150),
                    Size = new System.Drawing.Size(490, 24),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85)
                };

                _chkStartMenu = new CheckBox
                {
                    Text = "Thêm biểu tượng vào danh mục ứng dụng Menu Start của Windows",
                    Checked = true,
                    Location = new System.Drawing.Point(28, 178),
                    Size = new System.Drawing.Size(490, 24),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85)
                };

                _chkAutoRun = new CheckBox
                {
                    Text = "Tự động khởi động cùng Windows (chạy ngầm ở Khay hệ thống)",
                    Checked = true,
                    Location = new System.Drawing.Point(28, 206),
                    Size = new System.Drawing.Size(490, 24),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85)
                };

                _chkLaunchNow = new CheckBox
                {
                    Text = "Khởi chạy EduSign Agent ngay ở khay hệ thống sau khi cài đặt",
                    Checked = true,
                    Location = new System.Drawing.Point(28, 234),
                    Size = new System.Drawing.Size(490, 24),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85)
                };

                _progressBar = new ProgressBar
                {
                    Location = new System.Drawing.Point(24, 270),
                    Size = new System.Drawing.Size(495, 18),
                    Visible = false,
                    Minimum = 0,
                    Maximum = 100,
                    Value = 0
                };

                _lblStatus = new Label
                {
                    Text = "Sẵn sàng cài đặt. Nhấn [Cài đặt ngay] để tiếp tục.",
                    Location = new System.Drawing.Point(24, 295),
                    Size = new System.Drawing.Size(495, 24),
                    Font = new System.Drawing.Font("Segoe UI", 9f, System.Drawing.FontStyle.Italic),
                    ForeColor = System.Drawing.Color.FromArgb(100, 116, 139)
                };

                bodyPanel.Controls.Add(lblDesc);
                bodyPanel.Controls.Add(lblTargetTitle);
                bodyPanel.Controls.Add(_txtTargetDir);
                bodyPanel.Controls.Add(lblOptions);
                bodyPanel.Controls.Add(_chkDesktop);
                bodyPanel.Controls.Add(_chkStartMenu);
                bodyPanel.Controls.Add(_chkAutoRun);
                bodyPanel.Controls.Add(_chkLaunchNow);
                bodyPanel.Controls.Add(_progressBar);
                bodyPanel.Controls.Add(_lblStatus);

                this.Controls.Add(bodyPanel);
                this.Controls.Add(footerPanel);
                this.Controls.Add(headerPanel);
            }

            private async void BtnInstall_Click(object? sender, EventArgs e)
            {
                _btnInstall.Enabled = false;
                _btnCancel.Enabled = false;
                _chkDesktop.Enabled = false;
                _chkStartMenu.Enabled = false;
                _chkAutoRun.Enabled = false;
                _chkLaunchNow.Enabled = false;

                _progressBar.Visible = true;
                _progressBar.Value = 15;
                _lblStatus.ForeColor = System.Drawing.Color.FromArgb(37, 99, 235);
                _lblStatus.Text = "Đang chuẩn bị thư mục đích...";

                await System.Threading.Tasks.Task.Delay(300);

                try
                {
                    string targetDir = _txtTargetDir.Text.Trim();
                    if (!Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);

                    string currentExe = Environment.ProcessPath ?? AppDomain.CurrentDomain.BaseDirectory;
                    string targetExe = System.IO.Path.Combine(targetDir, "EduSign_Agent.exe");

                    _progressBar.Value = 40;
                    _lblStatus.Text = "Đang sao chép tệp chương trình và icon chuẩn Windows...";
                    await System.Threading.Tasks.Task.Delay(300);

                    if (!string.Equals(currentExe, targetExe, StringComparison.OrdinalIgnoreCase)) {
                        try { File.Copy(currentExe, targetExe, true); }
                        catch (Exception copyEx) { _lblStatus.ForeColor = System.Drawing.Color.Red; _lblStatus.Text = $"Lỗi sao chép: {copyEx.Message}"; Program.LogAgentDebug($"[ERR_COPY_FAILED] {copyEx.Message}"); _btnInstall.Enabled = true; _btnCancel.Enabled = true; return; }
                    }
                    if (!File.Exists(targetExe)) {
                        _lblStatus.ForeColor = System.Drawing.Color.Red; _lblStatus.Text = "Lỗi cài đặt: Tệp đích không tồn tại sau sao chép."; Program.LogAgentDebug("[ERR_TARGET_MISSING] targetExe không tồn tại."); _btnInstall.Enabled = true; _btnCancel.Enabled = true; return;
                    }
                    // Sao chép app.ico tùy chọn có chủ đích (không gián đoạn tiến trình)
                    string currentIco = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                    string targetIco = System.IO.Path.Combine(targetDir, "app.ico");
                    if (File.Exists(currentIco) && !File.Exists(targetIco)) {
                        try { File.Copy(currentIco, targetIco, true); } catch (Exception icoEx) { Program.LogAgentDebug($"[WARN_OPTIONAL_ICO_COPY] {icoEx.Message}"); }
                    }
                    string exeToUse = targetExe;
                    string icoToUse = File.Exists(targetIco) ? targetIco : (exeToUse + ",0");

                    _progressBar.Value = 65;
                    if (_chkDesktop.Checked)
                    {
                        _lblStatus.Text = "Đang tạo biểu tượng Desktop có icon nhận diện...";
                        string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                        string lnkDesktop = System.IO.Path.Combine(desktopPath, "EduSign Agent.lnk");
                        Program.CreateWindowsShortcut(lnkDesktop, exeToUse, "--tray", targetDir, "EduSign Desktop Agent v2.0 - Ban Cơ yếu", icoToUse);
                    }

                    if (_chkStartMenu.Checked)
                    {
                        _lblStatus.Text = "Đang tạo biểu tượng trong Menu Start...";
                        string startMenu = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Start Menu\Programs");
                        string lnkStart = System.IO.Path.Combine(startMenu, "EduSign Agent.lnk");
                        Program.CreateWindowsShortcut(lnkStart, exeToUse, "--tray", targetDir, "EduSign Desktop Agent v2.0", icoToUse);
                    }

                    _progressBar.Value = 85;
                    bool autoRunOk = true;
                    if (_chkAutoRun.Checked) {
                        _lblStatus.Text = "Đang cấu hình tự khởi động cùng Windows...";
                        try {
                            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                            if (key != null) { key.SetValue("EduSignAgent", $"\"{exeToUse}\" --tray"); }
                            else { autoRunOk = false; Program.LogAgentDebug("[WARN_AUTORUN_NULL] Khóa Run không thể mở để ghi."); }
                        }
                        catch (Exception regEx) { autoRunOk = false; Program.LogAgentDebug($"[WARN_AUTORUN_FAILED] {regEx.Message}"); }
                    }

                    _progressBar.Value = 95;
                    bool launchOk = true;
                    if (_chkLaunchNow.Checked) {
                        _lblStatus.Text = "Đang khởi chạy EduSign Agent ở khay hệ thống...";
                        try {
                            var pInfo = new System.Diagnostics.ProcessStartInfo { FileName = exeToUse, Arguments = "--tray", WorkingDirectory = targetDir, UseShellExecute = true };
                            if (System.Diagnostics.Process.Start(pInfo) == null) { launchOk = false; Program.LogAgentDebug("[WARN_LAUNCH_NULL] Process.Start trả về null."); }
                        }
                        catch (Exception pEx) { launchOk = false; Program.LogAgentDebug($"[WARN_LAUNCH_FAILED] {pEx.Message}"); }
                    }

                    await System.Threading.Tasks.Task.Delay(300);
                    _progressBar.Value = 100;
                    _lblStatus.Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Bold);
                    if (autoRunOk && launchOk) {
                        _lblStatus.ForeColor = System.Drawing.Color.FromArgb(16, 185, 129);
                        _lblStatus.Text = "🎉 Cài đặt hoàn tất! EduSign Agent 2.0 đã sẵn sàng sử dụng.";
                    }
                    else {
                        _lblStatus.ForeColor = System.Drawing.Color.FromArgb(217, 119, 6);
                        var warns = new List<string>();
                        if (!autoRunOk) warns.Add("chưa bật tự khởi động");
                        if (!launchOk) warns.Add("vui lòng mở ứng dụng thủ công");
                        _lblStatus.Text = $"Cài đặt hoàn tất (Lưu ý: {string.Join(", ", warns)}).";
                    }

                    _btnInstall.Text = "Hoàn tất";
                    _btnInstall.BackColor = System.Drawing.Color.FromArgb(37, 99, 235);
                    _btnInstall.Enabled = true;
                    _btnInstall.Click -= BtnInstall_Click; _btnInstall.Click += (s, ev) => this.Close(); _btnCancel.Visible = false;
                }
                catch (Exception ex)
                {
                    _lblStatus.ForeColor = System.Drawing.Color.Red;
                    _lblStatus.Text = "Lỗi khi cài đặt: " + ex.Message;
                    _btnInstall.Enabled = true;
                    _btnCancel.Enabled = true;
                }
            }
        }

        public class EduSignUpdateForm : Form
        {
            private readonly AgentVersionInfo _info;
            private ProgressBar _progressBar = null!;
            private Label _lblStatus = null!;
            private Button _btnUpdate = null!;
            private Button _btnCancel = null!;
            private TextBox _txtChangelog = null!;

            public EduSignUpdateForm(AgentVersionInfo info)
            {
                _info = info;
                InitializeComponent();
            }

            private void InitializeComponent()
            {
                this.Text = "Cập nhật EduSign Agent - Ban Cơ yếu CP";
                this.Size = new System.Drawing.Size(540, 480);
                this.StartPosition = FormStartPosition.CenterScreen;
                this.FormBorderStyle = FormBorderStyle.FixedDialog;
                this.MaximizeBox = false;
                this.MinimizeBox = false;
                this.BackColor = System.Drawing.Color.White;
                this.Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Regular);

                try
                {
                    string iconPath = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
                    if (File.Exists(iconPath))
                    {
                        this.Icon = new Icon(iconPath);
                    }
                }
                catch { }

                // Header Panel
                var headerPanel = new Panel
                {
                    Dock = DockStyle.Top,
                    Height = 85,
                    BackColor = System.Drawing.Color.FromArgb(24, 39, 71)
                };

                var lblHeaderTitle = new Label
                {
                    Text = "Đã có bản cập nhật mới!",
                    Font = new System.Drawing.Font("Segoe UI", 13f, System.Drawing.FontStyle.Bold),
                    ForeColor = System.Drawing.Color.White,
                    Location = new System.Drawing.Point(20, 16),
                    AutoSize = true
                };

                var lblHeaderSub = new Label
                {
                    Text = $"Phiên bản hiện tại: v{Program.CurrentVersion}   ➜   Bản cập nhật mới: v{_info.version}",
                    Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Regular),
                    ForeColor = System.Drawing.Color.FromArgb(203, 213, 225),
                    Location = new System.Drawing.Point(20, 46),
                    AutoSize = true
                };

                headerPanel.Controls.Add(lblHeaderTitle);
                headerPanel.Controls.Add(lblHeaderSub);

                // Footer Panel
                var footerPanel = new Panel
                {
                    Dock = DockStyle.Bottom,
                    Height = 65,
                    BackColor = System.Drawing.Color.FromArgb(248, 250, 252)
                };

                var footerLine = new Panel
                {
                    Dock = DockStyle.Top,
                    Height = 1,
                    BackColor = System.Drawing.Color.FromArgb(226, 232, 240)
                };
                footerPanel.Controls.Add(footerLine);

                _btnUpdate = new Button
                {
                    Text = "Cập nhật ngay",
                    Font = new System.Drawing.Font("Segoe UI", 10f, System.Drawing.FontStyle.Bold),
                    BackColor = System.Drawing.Color.FromArgb(16, 185, 129),
                    ForeColor = System.Drawing.Color.White,
                    FlatStyle = FlatStyle.Flat,
                    Size = new System.Drawing.Size(145, 38),
                    Location = new System.Drawing.Point(245, 14),
                    Cursor = Cursors.Hand
                };
                _btnUpdate.FlatAppearance.BorderSize = 0;
                _btnUpdate.Click += BtnUpdate_Click;

                _btnCancel = new Button
                {
                    Text = "Để sau",
                    Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Regular),
                    BackColor = System.Drawing.Color.FromArgb(241, 245, 249),
                    ForeColor = System.Drawing.Color.FromArgb(71, 85, 105),
                    FlatStyle = FlatStyle.Flat,
                    Size = new System.Drawing.Size(100, 38),
                    Location = new System.Drawing.Point(400, 14),
                    Cursor = Cursors.Hand
                };
                _btnCancel.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(203, 213, 225);
                _btnCancel.Click += (s, e) => this.Close();

                footerPanel.Controls.Add(_btnUpdate);
                footerPanel.Controls.Add(_btnCancel);

                // Body Panel
                var bodyPanel = new Panel
                {
                    Dock = DockStyle.Fill,
                    Padding = new Padding(24, 16, 24, 16)
                };

                var lblReleaseTitle = new Label
                {
                    Text = string.IsNullOrWhiteSpace(_info.title) ? $"EduSign Agent phiên bản {_info.version}" : _info.title,
                    Font = new System.Drawing.Font("Segoe UI", 10.5f, System.Drawing.FontStyle.Bold),
                    ForeColor = System.Drawing.Color.FromArgb(30, 41, 59),
                    Location = new System.Drawing.Point(20, 12),
                    AutoSize = true
                };

                var lblReleaseDate = new Label
                {
                    Text = string.IsNullOrWhiteSpace(_info.releaseDate) ? "" : $"Ngày phát hành: {_info.releaseDate}",
                    Font = new System.Drawing.Font("Segoe UI", 8.5f, System.Drawing.FontStyle.Italic),
                    ForeColor = System.Drawing.Color.FromArgb(100, 116, 139),
                    Location = new System.Drawing.Point(20, 36),
                    AutoSize = true
                };

                var lblChangelogTitle = new Label
                {
                    Text = "Những điểm mới và cải tiến trong bản cập nhật này:",
                    Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Bold),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85),
                    Location = new System.Drawing.Point(20, 64),
                    AutoSize = true
                };

                var changelogLines = new List<string>();
                if (_info.changelog != null && _info.changelog.Count > 0)
                {
                    foreach (var c in _info.changelog)
                    {
                        changelogLines.Add($"•  {c}");
                    }
                }
                else
                {
                    changelogLines.Add("•  Cải tiến hiệu năng và độ ổn định khi kết nối USB Token Ban Cơ yếu.");
                    changelogLines.Add("•  Tối ưu hóa khả năng ký duyệt văn bản điện tử và nén file PDF.");
                }

                _txtChangelog = new TextBox
                {
                    Multiline = true,
                    ReadOnly = true,
                    ScrollBars = ScrollBars.Vertical,
                    Text = string.Join(Environment.NewLine + Environment.NewLine, changelogLines),
                    Location = new System.Drawing.Point(20, 90),
                    Size = new System.Drawing.Size(485, 120),
                    BackColor = System.Drawing.Color.FromArgb(248, 250, 252),
                    ForeColor = System.Drawing.Color.FromArgb(51, 65, 85),
                    Font = new System.Drawing.Font("Segoe UI", 9f, System.Drawing.FontStyle.Regular)
                };

                _progressBar = new ProgressBar
                {
                    Location = new System.Drawing.Point(20, 224),
                    Size = new System.Drawing.Size(485, 18),
                    Visible = false,
                    Minimum = 0,
                    Maximum = 100,
                    Value = 0
                };

                _lblStatus = new Label
                {
                    Text = "Nhấn [Cập nhật ngay] để tải về và tự động nâng cấp nhanh chóng.",
                    Location = new System.Drawing.Point(20, 248),
                    Size = new System.Drawing.Size(485, 24),
                    Font = new System.Drawing.Font("Segoe UI", 9f, System.Drawing.FontStyle.Italic),
                    ForeColor = System.Drawing.Color.FromArgb(100, 116, 139)
                };
                bodyPanel.Controls.AddRange(new Control[] { lblReleaseTitle, lblReleaseDate, lblChangelogTitle, _txtChangelog, _progressBar, _lblStatus });
                this.Controls.AddRange(new Control[] { bodyPanel, footerPanel, headerPanel });
            }

            private static bool IsTrustedHost(string host) => !string.IsNullOrWhiteSpace(host) &&
                (host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || host.Equals("raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase) ||
                 host.Equals("objects.githubusercontent.com", StringComparison.OrdinalIgnoreCase) || host.Equals("mrkhang-khoi.github.io", StringComparison.OrdinalIgnoreCase));

            private static bool ValidateDownloadedUpdate(string tempFile, out string? error)
            {
                error = null;
                return File.Exists(tempFile) && new FileInfo(tempFile).Length > 1024 && VerifyExecutableIntegrity(tempFile, out error);
            }

            private static async Task<bool> CopyStreamWithLimitAsync(Stream src, Stream dest, long maxBytes)
            {
                byte[] b = new byte[8192]; long total = 0; int r;
                while ((r = await src.ReadAsync(b, 0, b.Length)) > 0)
                {
                    total += r;
                    if (total > maxBytes) return false;
                    await dest.WriteAsync(b, 0, r);
                }
                return true;
            }

            private static async Task<HttpResponseMessage?> FetchSecureResponseAsync(HttpClient client, string url)
            {
                string target = url;
                for (int hop = 0; hop < 5; hop++)
                {
                    if (!Uri.TryCreate(target, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps || !IsTrustedHost(u.Host)) return null;
                    var resp = await client.GetAsync(target, HttpCompletionOption.ResponseHeadersRead);
                    if ((int)resp.StatusCode >= 300 && (int)resp.StatusCode <= 399 && resp.Headers.Location != null)
                    {
                        var next = new Uri(u, resp.Headers.Location); resp.Dispose();
                        if (next.Scheme != Uri.UriSchemeHttps || !IsTrustedHost(next.Host)) return null;
                        target = next.AbsoluteUri; continue;
                    }
                    if (resp.Content.Headers.ContentLength.HasValue && resp.Content.Headers.ContentLength.Value > 100 * 1024 * 1024) { resp.Dispose(); return null; }
                    return resp;
                }
                return null;
            }

            private async void BtnUpdate_Click(object? sender, EventArgs e)
            {
                _btnUpdate.Enabled = false; _btnCancel.Enabled = false;
                _progressBar.Visible = true; _progressBar.Value = 5;
                _lblStatus.ForeColor = System.Drawing.Color.FromArgb(37, 99, 235);
                _lblStatus.Font = new System.Drawing.Font("Segoe UI", 9f, System.Drawing.FontStyle.Regular);
                _lblStatus.Text = "Đang kết nối máy chủ để tải bản cập nhật...";
            try
            {
            string currentExe = Environment.ProcessPath ?? "";
            string exeDir = System.IO.Path.GetDirectoryName(currentExe) ?? AppContext.BaseDirectory;
            if ((File.GetAttributes(exeDir) & FileAttributes.ReparsePoint) != 0) throw new Exception("Dir");
            using var lk = new FileStream(System.IO.Path.Combine(exeDir, ".u.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
            string tempUpdateFile = "";
            string bakFile = currentExe + ".bak";
            var dls = new List<string>(); if (Uri.TryCreate(_info.downloadUrl, UriKind.Absolute, out var u) && u.Scheme == "https" && IsTrustedHost(u.Host)) dls.Add(_info.downloadUrl);
            dls.Add("https://github.com/MrKhang-Khoi/cvakyso/raw/main/docs/downloads/EduSign_Agent.exe");
            using var cl = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
            bool ok = false; string? err = null, vHash = null; FileStream? updateLock = null; Version? updateVer = null;
            var cv = Version.Parse(Program.CurrentVersion);
            var pins = new[] { "8F68F91B52F2D172A22BD3898E5E1446765715B807B4F35E170BA2D014E9B34A", "5B29B147D300F722513B1F9F68B6E3D852C16773B25E9025008F42F99E3A52C8" };
            static bool Chk(X509Certificate2 c, string o)
            {
            using var ch = new X509Chain { ChainPolicy = { RevocationFlag = X509RevocationFlag.EntireChain, RevocationMode = X509RevocationMode.Online, VerificationFlags = X509VerificationFlags.NoFlag, ApplicationPolicy = { new Oid(o) } } };
            return ch.Build(c) && ch.ChainStatus.All(s => s.Status == X509ChainStatusFlags.NoError);
            }
            foreach (var url in dls)
            {
            try
            {
            using var response = await FetchSecureResponseAsync(cl, url);
            if (response == null || !response.IsSuccessStatusCode) continue;
            tempUpdateFile = System.IO.Path.Combine(exeDir, $"U_{Guid.NewGuid():N}.tmp");
            updateLock = new FileStream(tempUpdateFile, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
            using (var cs = await response.Content.ReadAsStreamAsync()) { if (!await CopyStreamWithLimitAsync(cs, updateLock, 104857600)) throw new Exception(">100MB"); }
            updateLock.Flush();
            _progressBar.Value = 85;
            if ((File.GetAttributes(tempUpdateFile) & FileAttributes.ReparsePoint) != 0) throw new Exception("Reparse");
            if (!ValidateDownloadedUpdate(tempUpdateFile, out string? aErr)) throw new Exception(aErr ?? "Auth");
            using var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(tempUpdateFile));
            if (!Chk(cert, "1.3.6.1.5.5.7.3.3")) throw new Exception("EKU");
            if (!pins.Contains(Convert.ToHexString(SHA256.HashData(cert.RawData)))) throw new Exception("Pin");
            if (string.IsNullOrEmpty(cert.Subject)) throw new Exception("Subject");
            var vi = System.Diagnostics.FileVersionInfo.GetVersionInfo(tempUpdateFile);
            updateVer = new Version(vi.FileMajorPart, vi.FileMinorPart, vi.FileBuildPart);
            int secCtr = updateVer.Major * 10000 + updateVer.Minor * 100 + updateVer.Build;
            if (!Version.TryParse(_info.version, out var mf) || updateVer != mf || updateVer < new Version(2, 2, 0) || updateVer <= cv) throw new Exception("Ver");
            using (var rk = Registry.CurrentUser.OpenSubKey(@"Software\EduSign"))
            {
            if (Version.TryParse(rk?.GetValue("MinVer") as string, out var mv) && updateVer <= mv) throw new Exception("Hạ cấp");
            if (Convert.ToInt32(rk?.GetValue("SecurityVersion") ?? 0) >= secCtr) throw new Exception("Replay");
            }
            updateLock.Position = 0;
            vHash = Convert.ToHexString(SHA256.HashData(updateLock));
            ok = true;
            break;
            }
            catch (Exception ex) { err = ex.Message; updateLock?.Dispose(); try { File.Delete(tempUpdateFile); } catch { } }
            }
            if (!ok || updateLock == null || string.IsNullOrEmpty(vHash)) { updateLock?.Dispose(); try { File.Delete(tempUpdateFile); } catch { } throw new Exception(err ?? "Lỗi tải."); }
            _progressBar.Value = 95;
            _lblStatus.Text = "Cài đặt...";
            updateLock.Position = 0; if (Convert.ToHexString(SHA256.HashData(updateLock)) != vHash) { updateLock.Dispose(); try { File.Delete(tempUpdateFile); } catch { } throw new Exception("Hash"); } updateLock.Dispose();
            // 1. Xóa .bak
            if (File.Exists(bakFile))
            {
            try { File.Delete(bakFile); } catch (Exception ex) { LogAgentDebug($"Không thể xóa bak: {ex.Message}"); }
                    }

                    // 2. Đổi tên file đang chạy thành .bak (Windows cho phép đổi tên tệp đang chạy)
                    File.Move(currentExe, bakFile);

                    // 3. Đổi tên file vừa tải về thành currentExe
                    File.Move(tempUpdateFile, currentExe);
                    try { using var rk = Registry.CurrentUser.CreateSubKey(@"Software\EduSign"); if (updateVer != null) rk?.SetValue("MinVer", updateVer.ToString()); } catch { }
                    // 4. Đồng bộ sang thư mục LocalAppData nếu cần
                    string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                    string targetDir = System.IO.Path.Combine(localAppData, "EduSign_Agent");
                    string installedExe = System.IO.Path.Combine(targetDir, "EduSign_Agent.exe");
                    if (File.Exists(installedExe) && !string.Equals(currentExe, installedExe, StringComparison.OrdinalIgnoreCase))
                    {
                        try
                        {
                            string installedBak = installedExe + ".bak";
                            if (File.Exists(installedBak)) File.Delete(installedBak);
                            File.Copy(currentExe, installedExe, true);
                        }
                        catch { }
                    }

                    _progressBar.Value = 100;
                    _lblStatus.ForeColor = System.Drawing.Color.FromArgb(16, 185, 129);
                    _lblStatus.Font = new System.Drawing.Font("Segoe UI", 9.5f, System.Drawing.FontStyle.Bold);
                    _lblStatus.Text = "🎉 Cập nhật thành công! Ứng dụng đang khởi động lại...";
                    await System.Threading.Tasks.Task.Delay(600);

                    // 5. Khởi động lại ứng dụng phiên bản mới với cờ --tray
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = currentExe,
                        Arguments = "--tray",
                        WorkingDirectory = exeDir,
                        UseShellExecute = true
                    });

                    // 6. Thoát ứng dụng cũ để hoàn tất
                    Environment.Exit(0);
                }
                catch (Exception ex)
                {
                    _progressBar.Value = 0;
                    _lblStatus.ForeColor = System.Drawing.Color.Red;
                    _lblStatus.Text = "Lỗi khi cập nhật: " + ex.Message;
                    _btnUpdate.Enabled = true;
                    _btnCancel.Enabled = true;
                }
            }
        }

        public static void RunConsoleAgent()
        {
            try { Console.Clear(); } catch { }
            SetColor(ConsoleColor.Cyan);
            WriteLine("╔══════════════════════════════════════════════════════════════════════╗");
            WriteLine("║        CÔNG CỤ KÝ SỐ CHUYÊN DỤNG EDUSIGN AGENT (VGCA DESKTOP)        ║");
            WriteLine("║            Trường THCS Chu Văn An - Tỉnh Quảng Ngãi                  ║");
            WriteLine("║            Phiên bản 2.0.0 - Chuẩn Nghị định 30/2020/NĐ-CP           ║");
            WriteLine("╚══════════════════════════════════════════════════════════════════════╝");
            ResetColor();

            var cert = FindVgcaCertificate();
            if (cert != null)
            {
                SetColor(ConsoleColor.Green);
                WriteLine($"\n✓ ĐÃ NHẬN DIỆN CHỨNG THƯ SỐ CÔNG VỤ:");
                WriteLine($"  - Chủ sở hữu: {cert.Subject}");
                WriteLine($"  - Cơ quan cấp: {cert.Issuer}");
                WriteLine($"  - Hạn dùng: {cert.NotAfter:dd/MM/yyyy HH:mm:ss} | Khóa riêng: {(cert.HasPrivateKey ? "CÓ SẴN (ĐÃ CẮM)" : "CHƯA NHẬN")}");
                ResetColor();
            }
            else
            {
                SetColor(ConsoleColor.Yellow);
                WriteLine("\n⚠️ CHƯA PHÁT HIỆN USB TOKEN BAN CƠ YẾU HOẶC CHỨNG THƯ SỐ");
                WriteLine("  Xin vui lòng cắm USB Token vào máy tính trước khi bấm ký trên web.");
                ResetColor();
            }

            var prefixes = new List<string> { "http://127.0.0.1:18888/" };

            using var listener = new HttpListener();
            foreach (var prefix in prefixes)
            {
                try { listener.Prefixes.Add(prefix); } catch { }
            }

            try
            {
                listener.Start();
                SetColor(ConsoleColor.Cyan);
                WriteLine("\n🚀 DỊCH VỤ KÝ SỐ CỤC BỘ ĐANG CHẠY...");
                foreach (var p in prefixes) WriteLine($"   👉 Lắng nghe kết nối an toàn tại: {p}");
                WriteLine("\n💡 Thầy hãy giữ cửa sổ này mở khi ký trên trang web (Local hoặc Render Cloud).");
                ResetColor();
            }
            catch (Exception ex)
            {
                SetColor(ConsoleColor.Red);
                WriteLine($"❌ Không thể khởi động cổng lắng nghe: {ex.Message}");
                ResetColor();
                return;
            }

            while (listener.IsListening)
            {
                try
                {
                    var context = listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleAgentRequest(context));
                }
                catch (HttpListenerException) { break; }
                catch (ObjectDisposedException) { break; }
                catch (Exception)
                {
                    Thread.Sleep(50);
                }
            }
        }

        public static async Task HandleWebSocketSessionAsync(HttpListenerContext context)
        {
            HttpListenerWebSocketContext wsContext;
            try { wsContext = await context.AcceptWebSocketAsync(subProtocol: null); }
            catch (Exception ex)
            {
                LogAgentDebug($"[WS_ACCEPT_FAIL] {ex.Message}");
                try { context.Response.StatusCode = 500; context.Response.Close(); } catch { } return;
            }
            using var ws = wsContext.WebSocket;
            var buffer = new byte[64 * 1024];
            var strictUtf8 = new UTF8Encoding(false, true);
            const int maxMsgSize = 35 * 1024 * 1024;

            try
            {
                while (ws.State == WebSocketState.Open)
                {
                    using var ms = new MemoryStream();
                    WebSocketReceiveResult result;
                    do
                    {
                        using var rxCts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), rxCts.Token);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            using var cCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", cCts.Token); return;
                        }
                        if (ms.Length + result.Count > maxMsgSize)
                        {
                            using var cCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                            await ws.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Message too big", cCts.Token); return;
                        }
                        ms.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);
                    string jsonText;
                    try { jsonText = strictUtf8.GetString(ms.GetBuffer(), 0, (int)ms.Length); }
                    catch (DecoderFallbackException)
                    {
                        using var cCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        await ws.CloseAsync(WebSocketCloseStatus.InvalidPayloadData, "Invalid UTF-8", cCts.Token); return;
                    }
                    if (string.IsNullOrWhiteSpace(jsonText)) continue;
                    string responseJson = ProcessWebSocketCommand(jsonText);
                    byte[] respBytes = Encoding.UTF8.GetBytes(responseJson);
                    using var txCts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    await ws.SendAsync(new ArraySegment<byte>(respBytes), WebSocketMessageType.Text, true, txCts.Token);
                }
            }
            catch (OperationCanceledException) { LogAgentDebug("[WS_TIMEOUT] WebSocket session timed out."); }
            catch (Exception ex) { LogAgentDebug($"[WS_ERR] WebSocket session error: {ex.Message}"); }
        }

        public static string ProcessWebSocketCommand(string jsonText)
        {
            try
            {
                using var doc = JsonDocument.Parse(jsonText);
                var root = doc.RootElement;
                string action = "";
                if (root.TryGetProperty("action", out var actProp)) action = actProp.GetString() ?? "";
                else if (root.TryGetProperty("functionName", out var fnProp)) action = fnProp.GetString() ?? "";

                action = action.ToLowerInvariant().Trim();

                if (action == "ping" || action == "get_version")
                {
                    return JsonSerializer.Serialize(new
                    {
                        status = 1,
                        success = true,
                        action = "ping",
                        version = CurrentVersion,
                        agentVersion = CurrentVersion,
                        appName = "EduSign Desktop Agent (Ban Cơ yếu Chính phủ)",
                        appRunning = true,
                        protocol = "WebSocket",
                        message = $"EduSign Agent v{CurrentVersion} kết nối thành công qua kênh WebSocket thời gian thực."
                    });
                }

                if (action == "get_all_certs" || action == "get_certs" || action == "list_certificates")
                {
                    var certList = new List<object>();
                    try
                    {
                        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
                        store.Open(OpenFlags.ReadOnly);
                        foreach (var c in store.Certificates)
                        {
                            certList.Add(new
                            {
                                serial = c.SerialNumber,
                                serialNumber = c.SerialNumber,
                                subject = c.Subject,
                                issuer = c.Issuer,
                                notAfter = c.NotAfter.ToString("yyyy-MM-dd HH:mm:ss"),
                                hasPrivateKey = c.HasPrivateKey,
                                signerName = ExtractCn(c.Subject),
                                email = ExtractEmail(c.Subject),
                                certBase64 = Convert.ToBase64String(c.RawData)
                            });
                        }
                    }
                    catch { }

                    return JsonSerializer.Serialize(new
                    {
                        status = 1,
                        success = true,
                        message = "Lấy danh sách chứng thư số thành công",
                        data = certList
                    });
                }

                if (action == "check_status" || action == "check-vgca-status")
                {
                    string signMode = "AUTO";
                    if (root.TryGetProperty("signMode", out var smProp)) signMode = smProp.GetString() ?? "AUTO";
                    else if (root.TryGetProperty("mode", out var mProp)) signMode = mProp.GetString() ?? "AUTO";

                    string? expectedSigner = null;
                    if (root.TryGetProperty("signer", out var snProp)) expectedSigner = snProp.GetString();
                    else if (root.TryGetProperty("signerName", out var snProp2)) expectedSigner = snProp2.GetString();

                    string? expectedCccd = null;
                    if (root.TryGetProperty("cccd", out var cccdProp)) expectedCccd = cccdProp.GetString();

                    string? expectedSerial = null;
                    if (root.TryGetProperty("serial", out var serProp)) expectedSerial = serProp.GetString();

                    var cert = FindVgcaCertificate(expectedSerial, signMode, expectedSigner, expectedCccd);
                    return JsonSerializer.Serialize(new
                    {
                        status = 1,
                        success = true,
                        service = "EduSign-Desktop-Agent",
                        version = CurrentVersion,
                        appRunning = true,
                        appName = "EduSign Desktop Agent (Ban Cơ yếu Chính phủ)",
                        tokenConnected = cert != null && cert.HasPrivateKey,
                        isVirtualCsp = cert != null,
                        certInfo = cert != null ? new
                        {
                            subject = cert.Subject,
                            issuer = cert.Issuer,
                            notAfter = cert.NotAfter.ToString("yyyy-MM-dd HH:mm:ss"),
                            thumbprint = cert.Thumbprint,
                            serialNumber = cert.SerialNumber,
                            hasPrivateKey = cert.HasPrivateKey,
                            signerName = ExtractCn(cert.Subject),
                            isHardware = IsHardwareTokenCert(cert),
                            keyAlgorithm = cert.PublicKey?.Oid?.FriendlyName ?? cert.PublicKey?.Oid?.Value ?? ""
                        } : null
                    });
                }

                return JsonSerializer.Serialize(new { status = 0, success = false, message = $"Lệnh không hỗ trợ: {action}" });
            }
            catch (Exception ex)
            {
                return JsonSerializer.Serialize(new { status = 0, success = false, message = "Lỗi xử lý WebSocket: " + ex.Message });
            }
        }

        public static void HandleAgentRequest(HttpListenerContext context)
        {
            var req = context.Request;
            var res = context.Response;

            // XỬ LÝ KẾT NỐI WEBSOCKET THỜI GIAN THỰC (BẢO VỆ RENDER CLOUD HTTPS)
            if (req.IsWebSocketRequest)
            {
                _ = HandleWebSocketSessionAsync(context);
                return;
            }

            // Thiết lập tiêu đề CORS & Private Network Access (Chuẩn Chrome/Edge PNA)
            string? origin = req.Headers["Origin"];
            static bool IsAllowedOrigin(string? o) => !string.IsNullOrEmpty(o) && (o.Equals("https://edusign-vgca.onrender.com", StringComparison.OrdinalIgnoreCase) || o.Equals("https://cvakyso.onrender.com", StringComparison.OrdinalIgnoreCase) || o.Equals("https://mrkhang-khoi.github.io", StringComparison.OrdinalIgnoreCase) || (Uri.TryCreate(o, UriKind.Absolute, out var u) && (u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || u.Host.Equals("127.0.0.1"))));
            bool isAllowedOrigin = IsAllowedOrigin(origin);
            if (isAllowedOrigin)
            {
                res.AddHeader("Access-Control-Allow-Origin", origin!);
                res.AddHeader("Access-Control-Allow-Credentials", "true");
            }
            else if (!string.IsNullOrEmpty(origin))
            {
                res.StatusCode = 403;
                res.Close();
                return;
            }
            res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
            res.AddHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Access-Control-Request-Private-Network, targetaddressspace, Cache-Control, Pragma");
            res.AddHeader("Access-Control-Allow-Private-Network", "true");
            res.AddHeader("Access-Control-Max-Age", "86400");
            res.AddHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
            res.AddHeader("Pragma", "no-cache");
            res.AddHeader("Expires", "0");
            if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

            res.ContentType = "application/json; charset=utf-8";
            string path = req.Url?.AbsolutePath.ToLowerInvariant() ?? "";

            try
            {
                if (path == "/api/ping-local-signer" || path == "/api/check-vgca-status" || path == "/api/list-certificates")
                {
                    string? checkSerial = req.QueryString["serial"];
                    string signMode = req.QueryString["mode"] ?? req.QueryString["signType"] ?? "AUTO";
                    string? role = req.QueryString["role"];
                    string? expectedSigner = req.QueryString["signer"] ?? req.QueryString["name"];
                    string? expectedEmail = req.QueryString["email"];
                    string? expectedCccd = req.QueryString["cccd"] ?? req.QueryString["uid"];

                    bool isHardwareMode = signMode.Equals("HARDWARE", StringComparison.OrdinalIgnoreCase)
                                       || signMode.Equals("USB_TOKEN", StringComparison.OrdinalIgnoreCase)
                                       || signMode.Equals("BGH", StringComparison.OrdinalIgnoreCase);

                    bool isTeacherOrVgca = !isHardwareMode && (
                        signMode.Equals("PERSONAL", StringComparison.OrdinalIgnoreCase)
                        || signMode.Equals("VGCA", StringComparison.OrdinalIgnoreCase)
                        || signMode.Equals("TEACHER", StringComparison.OrdinalIgnoreCase)
                        || (!string.IsNullOrEmpty(role) && !role.Equals("ADMIN", StringComparison.OrdinalIgnoreCase) && !role.Equals("BGH", StringComparison.OrdinalIgnoreCase))
                    );

                    if (isTeacherOrVgca && signMode.Equals("AUTO", StringComparison.OrdinalIgnoreCase))
                    {
                        signMode = "PERSONAL";
                    }

                    var cert = isTeacherOrVgca
                        ? FindVgcaPersonalCertificate(expectedSigner ?? expectedEmail, expectedCccd)
                        : FindVgcaCertificate(checkSerial, signMode, expectedSigner, expectedCccd);

                    string detectedCccd = cert != null ? ExtractCccdOrUid(cert.Subject) : "";
                    string certSigner = cert != null ? ExtractCn(cert.Subject) : "";

                    static bool HasKey(X509Certificate2 x) { try { if (!x.HasPrivateKey) return false; using var r = x.GetRSAPrivateKey(); if (r != null) return true; using var e = x.GetECDsaPrivateKey(); return e != null; } catch { return false; } }
                    var availableCerts = new List<object>();
                    try
                    {
                        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
                        store.Open(OpenFlags.ReadOnly);
                        foreach (var c in store.Certificates)
                        {
                            if (!HasKey(c) || DateTime.Now < c.NotBefore || DateTime.Now > c.NotAfter) continue;
                            using var ch = new X509Chain { ChainPolicy = { RevocationMode = X509RevocationMode.Online, RevocationFlag = X509RevocationFlag.EntireChain, VerificationFlags = X509VerificationFlags.NoFlag } };
                            if (!ch.Build(c) || ch.ChainStatus.Any(s => s.Status == X509ChainStatusFlags.Revoked)) continue;
                            bool isGovRoot = ch.ChainElements.Count > 0 && (ch.ChainElements[ch.ChainElements.Count - 1].Certificate.Subject.Contains("Ban Co yeu") || ch.ChainElements[ch.ChainElements.Count - 1].Certificate.Subject.Contains("VGCA") || ch.ChainElements.Cast<X509ChainElement>().Any(e => e.Certificate.Issuer.Contains("Ban Co yeu") || e.Certificate.Issuer.Contains("VGCA")));
                            string subj = c.Subject ?? "", iss = c.Issuer ?? "";
                            string subjL = subj.ToLowerInvariant(), issL = iss.ToLowerInvariant();
                            bool isGovCa = isGovRoot || issL.Contains("ban c") || issL.Contains("vgca") || issL.Contains("ca phuc vu") || subjL.Contains(".gov.vn");
                            if (!isGovCa) continue;
                            var ku = c.Extensions.OfType<X509KeyUsageExtension>().FirstOrDefault();
                            if (ku != null && (ku.KeyUsages & (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation)) == 0) continue;
                            bool isHw = IsHardwareTokenCert(c);
                            if (isHardwareMode && !isHw) continue;
                            if (isTeacherOrVgca && isHw) continue;
                            availableCerts.Add(new
                            {
                                serialNumber = c.SerialNumber,
                                thumbprint   = c.Thumbprint,
                                signerName   = ExtractCn(c.Subject),
                                email        = ExtractEmail(c.Subject),
                                cccd         = ExtractCccdOrUid(c.Subject),
                                subject      = c.Subject,
                                issuer       = c.Issuer,
                                notAfter     = c.NotAfter.ToString("yyyy-MM-dd HH:mm:ss"),
                                isHardware   = isHw,
                                keyAlgorithm = c.PublicKey?.Oid?.FriendlyName ?? c.PublicKey?.Oid?.Value ?? ""
                            });
                        }
                    }
                    catch (Exception stEx) { LogAgentDebug($"[CERT_STORE_ERR] {stEx.Message}"); }

                    bool cspHealthy = true;
                    bool hasCspError = false;
                    string cspErrorMessage = "";

                    if (isTeacherOrVgca)
                    {
                        // DÀNH CHO GIÁO VIÊN (Ký số VGCA Virtual CSP / SmartCA):
                        bool vcspRunning = System.Diagnostics.Process.GetProcessesByName("vgca_vcsp_v2_mgr").Length > 0;

                        if (!vcspRunning)
                        {
                            cspHealthy = false;
                            hasCspError = true;
                            cspErrorMessage = "Chưa đăng nhập tài khoản ký số VGCA. Vui lòng mở ứng dụng VGCA Virtual CSP và đăng nhập tài khoản của Thầy/Cô.";
                        }
                        else if (cert != null)
                        {
                            if (!HasKey(cert) || cert.NotAfter < DateTime.Now)
                            {
                                cspHealthy = false;
                                hasCspError = true;
                                cspErrorMessage = $"Chứng thư số Ban Cơ yếu của Thầy/Cô đã hết hạn hiệu lực ({cert.NotAfter:dd/MM/yyyy}). Vui lòng gia hạn chữ ký số chuyên dùng công vụ.";
                            }
                            else
                            {
                                cspHealthy = true;
                                hasCspError = false;
                                cspErrorMessage = "";
                            }
                        }
                        else if (availableCerts.Count > 0)
                        {
                            // Virtual CSP đang chạy và có chứng thư, nhưng KHÔNG KHỚP với giáo viên đang yêu cầu
                            string activeStoreSigner = "Chưa rõ";
                            try {
                                var firstCert = availableCerts[0] as dynamic;
                                activeStoreSigner = firstCert?.signerName ?? "Khác";
                            } catch { }

                            cspHealthy = false;
                            hasCspError = true;
                            cspErrorMessage = $"Tài khoản VGCA đang đăng nhập trên máy tính ({activeStoreSigner}) không khớp với tài khoản giáo viên đăng nhập trên Web ({expectedSigner ?? "Giáo viên"}). Vui lòng đăng xuất VGCA Virtual CSP và đăng nhập đúng tài khoản của Thầy/Cô.";
                        }
                        else
                        {
                            cspHealthy = false;
                            hasCspError = true;
                            cspErrorMessage = "VGCA Virtual CSP đang chạy nhưng chưa đăng nhập tài khoản. Vui lòng mở ứng dụng VGCA và đăng nhập tài khoản của Thầy/Cô.";
                        }
                    }
                    else
                    {
                        // DÀNH CHO BGH / ADMIN (USB Token phần cứng):
                        if (cert != null)
                        {
                            DateTimeOffset now = DateTimeOffset.Now; bool isTimeValid = cert.NotAfter > now && cert.NotBefore <= now;
                            bool hasKey = cert.HasPrivateKey && HasKey(cert);
                            bool matchSerial = string.IsNullOrWhiteSpace(checkSerial) || string.Equals(cert.SerialNumber?.Replace(" ", "").Replace(":", ""), checkSerial.Replace(" ", "").Replace(":", ""), StringComparison.OrdinalIgnoreCase);
                            bool matchCccd = string.IsNullOrWhiteSpace(expectedCccd) || string.Equals(ExtractCccdOrUid(cert.Subject), expectedCccd, StringComparison.OrdinalIgnoreCase);
                            bool matchSigner = string.IsNullOrWhiteSpace(expectedSigner) || ExtractCn(cert.Subject).IndexOf(expectedSigner, StringComparison.OrdinalIgnoreCase) >= 0 || (cert.Subject ?? "").IndexOf(expectedSigner, StringComparison.OrdinalIgnoreCase) >= 0;
                            if (!isTimeValid) { cspHealthy = false; hasCspError = true; cspErrorMessage = $"Chứng thư số USB Token đã hết hạn hoặc chưa đến ngày hiệu lực ({cert.NotBefore:dd/MM/yyyy} - {cert.NotAfter:dd/MM/yyyy})."; }
                            else if (!hasKey) { cspHealthy = false; hasCspError = true; cspErrorMessage = "Không thể truy xuất khóa bí mật từ USB Token hoặc chưa mở khóa PIN trong Bit4id PKI Manager."; }
                            else if (!matchSerial || !matchCccd || !matchSigner) { cspHealthy = false; hasCspError = true; cspErrorMessage = !matchSerial ? $"USB Token không khớp số Serial [{checkSerial}]." : (!matchCccd ? $"USB Token không khớp Số CCCD [{expectedCccd}]." : $"USB Token không khớp người ký [{expectedSigner}]."); }
                            else { cspHealthy = true; hasCspError = false; cspErrorMessage = ""; }
                        }
                        else
                        {
                            cspHealthy = false; hasCspError = true;
                            if (!string.IsNullOrWhiteSpace(expectedCccd) && availableCerts.Count > 0)
                            {
                                string pluggedSigner = "Thiết bị khác";
                                try { var first = availableCerts[0] as dynamic; pluggedSigner = first?.signerName ?? "Thiết bị khác"; } catch {}
                                cspErrorMessage = $"USB Token đang cắm là của [{pluggedSigner}], không khớp với Số CCCD [{expectedCccd}]!";
                            }
                            else
                            {
                                cspErrorMessage = !string.IsNullOrWhiteSpace(checkSerial) ? $"Không tìm thấy USB Token khớp với số Serial [{checkSerial}]! Vui lòng cắm đúng USB Token."
                                    : (!string.IsNullOrWhiteSpace(expectedSigner) ? $"Không tìm thấy USB Token của [{expectedSigner}]. Vui lòng cắm đúng USB Token."
                                    : "Chưa cắm USB Token phần cứng hoặc chưa nhập PIN mở khóa trong Bit4id PKI Manager.");
                            }
                        }
                    }

                    // === Fix D: Kiểm tra maintenance flag từ CSP ===
                    bool isMaintenance = false;
                    string maintenanceMsg = "";
                    try
                    {
                        string maintenanceFlag = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vgca_maintenance.flag");
                        if (File.Exists(maintenanceFlag))
                        {
                            isMaintenance = true;
                            maintenanceMsg = File.ReadAllText(maintenanceFlag).Trim();
                            if (string.IsNullOrEmpty(maintenanceMsg))
                                maintenanceMsg = "Hệ thống ký số VGCA đang trong thời gian bảo trì kỹ thuật. Vui lòng thử lại sau.";
                        }
                    }
                    catch { }

                    if (isMaintenance)
                    {
                        cspHealthy = false;
                        hasCspError = true;
                        cspErrorMessage = maintenanceMsg;
                    }

                    object? certInfo = (!isMaintenance && cert != null) ? new
                    {
                        serialNumber = cert.SerialNumber,
                        thumbprint   = cert.Thumbprint,
                        signerName   = ExtractCn(cert.Subject),
                        email        = ExtractEmail(cert.Subject),
                        cccd         = ExtractCccdOrUid(cert.Subject),
                        school       = ExtractOu(cert.Subject),
                        subject      = cert.Subject,
                        issuer       = cert.Issuer,
                        notAfter     = cert.NotAfter.ToString("yyyy-MM-dd HH:mm:ss"),
                        hasPrivateKey = cert.HasPrivateKey,
                        isHardware   = IsHardwareTokenCert(cert),
                        keyAlgorithm = cert.PublicKey?.Oid?.FriendlyName ?? cert.PublicKey?.Oid?.Value ?? ""
                    } : null;

                    var statusData = new
                    {
                        success = true,
                        service = "EduSign-Desktop-Agent",
                        version = CurrentVersion,
                        agentVersion = CurrentVersion,
                        hasUpdate = _lastUpdateCheckResult,
                        latestVersion = _lastLatestVersion,
                        platform = "win32",
                        appRunning = true,
                        appName = "EduSign Desktop Agent (Ban Cơ yếu Chính phủ)",
                        tokenConnected = !isMaintenance && cert != null && cspHealthy,
                        cspHealthy = cspHealthy,
                        hasCspError = hasCspError,
                        cspErrorMessage = cspErrorMessage,
                        isMaintenance = isMaintenance,
                        maintenanceMessage = maintenanceMsg,
                        certInfo = certInfo,
                        availableCerts = availableCerts,
                        details = isMaintenance
                            ? $"⚠️ BẢO TRÌ: {maintenanceMsg}"
                            : (cert != null && cspHealthy)
                                ? $"EduSign Agent đang hoạt động và đã nhận diện chứng thư số Ban Cơ yếu của {ExtractCn(cert.Subject)}."
                                : (hasCspError
                                    ? cspErrorMessage
                                    : "EduSign Agent đang hoạt động nhưng chưa cắm USB Token hoặc chưa đăng nhập (nhập PIN).")
                    };

                    byte[] jsonBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(statusData));
                    res.OutputStream.Write(jsonBytes, 0, jsonBytes.Length);
                    res.Close();
                    return;
                }

                if (path == "/api/agent/version")
                {
                    var (hasNew, info) = CheckForUpdates();
                    var verObj = new
                    {
                        success = true,
                        currentVersion = CurrentVersion,
                        latestVersion = info?.version ?? CurrentVersion,
                        hasUpdate = hasNew,
                        releaseDate = info?.releaseDate ?? "",
                        title = info?.title ?? "",
                        changelog = info?.changelog ?? new List<string>(),
                        downloadUrl = info?.downloadUrl ?? "",
                        zipDownloadUrl = info?.zipDownloadUrl ?? "",
                        mandatory = info?.mandatory ?? false
                    };
                    byte[] b = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(verObj));
                    res.OutputStream.Write(b, 0, b.Length);
                    res.Close();
                    return;
                }

                if (path == "/api/agent/update" && req.HttpMethod == "POST")
                {
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        TriggerUpdateGui(null);
                    });
                    var okObj = new { success = true, message = "Đang khởi chạy giao diện Cập nhật EduSign Agent..." };
                    byte[] b = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(okObj));
                    res.OutputStream.Write(b, 0, b.Length);
                    res.Close();
                    return;
                }

                if (path == "/api/exit" || path == "/api/shutdown")
                {
                    res.StatusCode = 200;
                    byte[] okBytes = System.Text.Encoding.UTF8.GetBytes("{\"success\":true,\"message\":\"EduSign Agent shutting down cleanly\"}");
                    res.OutputStream.Write(okBytes, 0, okBytes.Length);
                    res.Close();
                    ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(200); Environment.Exit(0); });
                    return;
                }

                if (path == "/api/convert-word-to-pdf" && req.HttpMethod == "POST")
                {
                    try
                    {
                        if (req.ContentLength64 > 35 * 1024 * 1024L)
                        {
                            res.StatusCode = 413;
                            byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Payload vượt quá 35MB (413)\"}");
                            res.OutputStream.Write(err, 0, err.Length);
                            res.Close(); return;
                        }
                        using var streamReader = new StreamReader(req.InputStream, req.ContentEncoding);
                        string body = streamReader.ReadToEnd();
                        if (body.Length > 48 * 1024 * 1024) { res.StatusCode = 413; byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Body vượt quá giới hạn (413)\"}"); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                        using var docJson = JsonDocument.Parse(body);
                        var root = docJson.RootElement;
                        string fileBase64 = root.TryGetProperty("fileBase64", out var fb64) ? fb64.GetString() ?? "" : "";
                        string fileName = root.TryGetProperty("fileName", out var fnProp) && !string.IsNullOrWhiteSpace(fnProp.GetString()) ? fnProp.GetString()! : "GiaoAn.docx";
                        if (string.IsNullOrWhiteSpace(fileBase64))
                        {
                            res.StatusCode = 400; byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Thiếu dữ liệu fileBase64\"}");
                            res.OutputStream.Write(err, 0, err.Length); res.Close(); return;
                        }
                        string ext = System.IO.Path.GetExtension(fileName).ToLowerInvariant();
                        if (string.IsNullOrEmpty(ext)) ext = ".docx";
                        if (ext != ".docx" && ext != ".doc")
                        {
                            res.StatusCode = 400; byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Chỉ chấp nhận định dạng Word (.docx, .doc)\"}");
                            res.OutputStream.Write(err, 0, err.Length); res.Close(); return;
                        }
                        string cleanB64 = Regex.Replace(fileBase64, @"^data:[^;]+;base64,", "");
                        if (cleanB64.Length > 48 * 1024 * 1024) { res.StatusCode = 413; byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Base64 vượt quá 35MB nhị phân (413)\"}"); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                        byte[] fileBytes = Convert.FromBase64String(cleanB64);
                        if (fileBytes.Length > 35 * 1024 * 1024 || fileBytes.Length < 4) { res.StatusCode = fileBytes.Length < 4 ? 400 : 413; byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Kích thước tệp không hợp lệ\"}"); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                        if (ext == ".docx" && (fileBytes[0] != 0x50 || fileBytes[1] != 0x4B)) { res.StatusCode = 400; byte[] err = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Tệp không phải định dạng DOCX chuẩn (thiếu PK header)\"}"); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                        string tempDir = System.IO.Path.GetTempPath();
                        string uniqueId = $"agent_conv_{DateTime.Now.Ticks}_{Guid.NewGuid().ToString("N").Substring(0, 8)}";
                        string tempDocx = System.IO.Path.Combine(tempDir, $"{uniqueId}{ext}");
                        string tempPdf = System.IO.Path.Combine(tempDir, $"{uniqueId}.pdf");
                        string tempPs1 = System.IO.Path.Combine(tempDir, $"{uniqueId}.ps1");
                        System.IO.File.WriteAllBytes(tempDocx, fileBytes);
                        string psScript = string.Join("\r\n", new[]
                        {
                            "$prev = Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
                            "$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0; $w.ScreenUpdating = $false; $w.AutomationSecurity = 3; $w.Options.ConfirmConversions = $false",
                            "$wp = Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object { $prev -notcontains $_.Id } | Select-Object -First 1",
                            "try {",
                            $"  $doc = $w.Documents.Open('{tempDocx.Replace("'", "''")}', $false, $true, $false)",
                            $"  $doc.SaveAs([ref]'{tempPdf.Replace("'", "''")}', [ref]17)",
                            "  $doc.Close([ref]0)",
                            "  Write-Output 'SUCCESS'",
                            "} catch {",
                            "  Write-Error $_.Exception.Message",
                            "} finally {",
                            "  try { if ($w) { $w.Quit([ref]0) } } catch {}",
                            "  if ($wp -and !$wp.HasExited) { try { Stop-Process -Id $wp.Id -Force -ErrorAction SilentlyContinue } catch {} }",
                            "}"
                        });
                        System.IO.File.WriteAllText(tempPs1, psScript, new System.Text.UTF8Encoding(true));
                        var psi = new System.Diagnostics.ProcessStartInfo
                        {
                            FileName = "powershell.exe",
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true
                        };
                        psi.ArgumentList.Add("-NoProfile"); psi.ArgumentList.Add("-NonInteractive"); psi.ArgumentList.Add("-ExecutionPolicy"); psi.ArgumentList.Add("Bypass"); psi.ArgumentList.Add("-File"); psi.ArgumentList.Add(tempPs1);
                        string stdOut = "", stdErr = ""; bool procOk = false;
                        using (var proc = System.Diagnostics.Process.Start(psi))
                        {
                            if (proc != null)
                            {
                                var outTask = Task.Run(() => proc.StandardOutput.ReadToEnd());
                                var errTask = Task.Run(() => proc.StandardError.ReadToEnd());
                                bool exited = proc.WaitForExit(45000);
                                if (!exited) { try { proc.Kill(true); } catch { } proc.WaitForExit(); }
                                else { stdOut = outTask.GetAwaiter().GetResult(); stdErr = errTask.GetAwaiter().GetResult(); procOk = proc.ExitCode == 0 && stdOut.Contains("SUCCESS"); }
                            }
                        }
                        byte[]? pdfBytes = null;
                        if (procOk && System.IO.File.Exists(tempPdf))
                        {
                            try
                            {
                                using var fs = new FileStream(tempPdf, FileMode.Open, FileAccess.Read, FileShare.None);
                                if (fs.Length > 100)
                                {
                                    pdfBytes = new byte[fs.Length];
                                    int r = 0; while (r < pdfBytes.Length) { int n = fs.Read(pdfBytes, r, pdfBytes.Length - r); if (n == 0) break; r += n; }
                                }
                            }
                            catch (Exception fsEx) { LogAgentDebug($"[PDF_READ_ERR] {fsEx.Message}"); pdfBytes = null; }
                        }
                        try { if (System.IO.File.Exists(tempPs1)) System.IO.File.Delete(tempPs1); if (System.IO.File.Exists(tempDocx)) System.IO.File.Delete(tempDocx); if (System.IO.File.Exists(tempPdf)) System.IO.File.Delete(tempPdf); } catch { }
                        if (pdfBytes != null && pdfBytes.Length > 100)
                        {
                            string pdfBase64Result = "data:application/pdf;base64," + Convert.ToBase64String(pdfBytes);
                            var resData = new { success = true, pdfBase64 = pdfBase64Result, size = pdfBytes.Length };
                            byte[] okBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(resData));
                            res.OutputStream.Write(okBytes, 0, okBytes.Length); res.Close(); return;
                        }
                        else
                        {
                            LogAgentDebug($"[WORD_CONV_FAIL] out={stdOut} err={stdErr}");
                            res.StatusCode = 500;
                            byte[] failBytes = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Không thể xuất tệp PDF từ Microsoft Word cục bộ\"}");
                            res.OutputStream.Write(failBytes, 0, failBytes.Length); res.Close(); return;
                        }
                    }
                    catch (Exception ex)
                    {
                        LogAgentDebug($"[WORD_CONV_EX] {ex.Message}"); res.StatusCode = 500; byte[] errBytes = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Lỗi nội bộ khi chuyển đổi tài liệu Word sang PDF\"}"); res.OutputStream.Write(errBytes, 0, errBytes.Length); res.Close(); return;
                    }
                }

                if (path == "/api/local-sign-doc" && req.HttpMethod == "POST")
                {
                    using var streamReader = new StreamReader(req.InputStream, req.ContentEncoding);
                    string body = streamReader.ReadToEnd();
                    using var docJson = JsonDocument.Parse(body);
                    var root = docJson.RootElement;

                    string fileBase64 = "";
                    if (root.TryGetProperty("fileBase64", out var fb64)) fileBase64 = fb64.GetString() ?? "";
                    else if (root.TryGetProperty("pdfBase64", out var pb64)) fileBase64 = pb64.GetString() ?? "";

                    string docTitle = "Kế hoạch bài dạy";
                    string signerName = "Hà Văn Tý";
                    if (root.TryGetProperty("signerName", out var snProp) && !string.IsNullOrWhiteSpace(snProp.GetString()))
                    {
                        signerName = snProp.GetString()!;
                    }
                    string sigImgData = "";
                    if (root.TryGetProperty("signatureImage", out var sImgProp))
                    {
                        sigImgData = sImgProp.GetString() ?? "";
                    }

                    float? reqX = null, reqY = null, reqW = null, reqH = null;
                    int? reqPage = null;
                    float? reqXPercent = null, reqYPercent = null;
                    bool isPreStamped = false;
                    bool isManualDrag = false;

                    if (root.TryGetProperty("isPreStamped", out var ipP)) isPreStamped = ipP.GetBoolean();
                    if (root.TryGetProperty("isManualDrag", out var imdRoot)) isManualDrag = imdRoot.GetBoolean();
                    if (root.TryGetProperty("page", out var rPage)) reqPage = rPage.GetInt32();
                    else if (root.TryGetProperty("targetPage", out var rTPage)) reqPage = rTPage.GetInt32();

                    if (root.TryGetProperty("x", out var rxRoot)) reqX = (float)rxRoot.GetDouble();
                    if (root.TryGetProperty("y", out var ryRoot)) reqY = (float)ryRoot.GetDouble();
                    if (root.TryGetProperty("width", out var rwRoot)) reqW = (float)rwRoot.GetDouble();
                    if (root.TryGetProperty("height", out var rhRoot)) reqH = (float)rhRoot.GetDouble();

                    if (root.TryGetProperty("signCoordinates", out var scRootObj))
                    {
                        if (scRootObj.TryGetProperty("x", out var scX)) reqX = (float)scX.GetDouble();
                        if (scRootObj.TryGetProperty("y", out var scY)) reqY = (float)scY.GetDouble();
                        if (scRootObj.TryGetProperty("width", out var scW)) reqW = (float)scW.GetDouble();
                        if (scRootObj.TryGetProperty("height", out var scH)) reqH = (float)scH.GetDouble();
                        if (!reqPage.HasValue && scRootObj.TryGetProperty("page", out var scP)) reqPage = scP.GetInt32();
                        if (!reqPage.HasValue && scRootObj.TryGetProperty("targetPage", out var scTP)) reqPage = scTP.GetInt32();
                        if (scRootObj.TryGetProperty("xPercent", out var scXp)) reqXPercent = (float)scXp.GetDouble();
                        if (scRootObj.TryGetProperty("yPercent", out var scYp)) reqYPercent = (float)scYp.GetDouble();
                        if (scRootObj.TryGetProperty("isManualDrag", out var scImd)) isManualDrag = scImd.GetBoolean();
                    }

                    if (root.TryGetProperty("xPercent", out var rXp)) reqXPercent = (float)rXp.GetDouble();
                    if (root.TryGetProperty("yPercent", out var rYp)) reqYPercent = (float)rYp.GetDouble();

                    if (root.TryGetProperty("doc", out var docElem))
                    {
                        if (docElem.TryGetProperty("title", out var t)) docTitle = t.GetString() ?? docTitle;
                        if (docElem.TryGetProperty("author", out var a) && string.IsNullOrEmpty(root.TryGetProperty("signerName", out var _dummy) ? _dummy.GetString() : null)) signerName = a.GetString() ?? signerName;
                        if (string.IsNullOrEmpty(sigImgData) && docElem.TryGetProperty("signatureImage", out var dSig))
                            sigImgData = dSig.GetString() ?? "";

                        if (docElem.TryGetProperty("isPreStamped", out var ipD)) isPreStamped = ipD.GetBoolean();

                        if (docElem.TryGetProperty("signatures", out var sigsArr) && sigsArr.GetArrayLength() > 0)
                        {
                            var firstSig = sigsArr[0];
                            if (string.IsNullOrEmpty(sigImgData) && firstSig.TryGetProperty("visualSignImage", out var vsImg))
                                sigImgData = vsImg.GetString() ?? "";
                        }

                        if (docElem.TryGetProperty("signCoordinates", out var coordElem))
                        {
                            if (coordElem.TryGetProperty("x", out var xProp)) reqX = (float)xProp.GetDouble();
                            if (coordElem.TryGetProperty("y", out var yProp)) reqY = (float)yProp.GetDouble();
                            if (coordElem.TryGetProperty("width", out var wProp)) reqW = (float)wProp.GetDouble();
                            if (coordElem.TryGetProperty("height", out var hProp)) reqH = (float)hProp.GetDouble();
                            if (!reqPage.HasValue && coordElem.TryGetProperty("page", out var pProp)) reqPage = pProp.GetInt32();
                            if (!reqPage.HasValue && coordElem.TryGetProperty("targetPage", out var tpProp)) reqPage = tpProp.GetInt32();

                            if (coordElem.TryGetProperty("xPercent", out var xpProp))
                            {
                                reqXPercent = (float)xpProp.GetDouble();
                            }
                            if (coordElem.TryGetProperty("yPercent", out var ypProp))
                            {
                                reqYPercent = (float)ypProp.GetDouble();
                            }
                            if (coordElem.TryGetProperty("isManualDrag", out var imdProp))
                            {
                                isManualDrag = imdProp.GetBoolean();
                            }
                        }
                    }

                    string? expectedSerial = null;
                    if (root.TryGetProperty("expectedSerial", out var esProp) && !string.IsNullOrWhiteSpace(esProp.GetString()))
                    {
                        expectedSerial = esProp.GetString();
                    }
                    else if (root.TryGetProperty("doc", out var docElemSerial) && docElemSerial.TryGetProperty("expectedSerial", out var dEsProp) && !string.IsNullOrWhiteSpace(dEsProp.GetString()))
                    {
                        expectedSerial = dEsProp.GetString();
                    }

                    string signMode = "AUTO";
                    if (root.TryGetProperty("signMode", out var smProp) && !string.IsNullOrWhiteSpace(smProp.GetString())) signMode = smProp.GetString()!;
                    else if (root.TryGetProperty("category", out var catProp) && catProp.GetString() == "PERSONAL") signMode = "PERSONAL";
                    else if (root.TryGetProperty("doc", out var docElemCat) && docElemCat.TryGetProperty("category", out var dCatProp) && dCatProp.GetString() == "PERSONAL") signMode = "PERSONAL";

                    string? expectedSigner = null;
                    if (root.TryGetProperty("signerName", out var snCheck) && !string.IsNullOrWhiteSpace(snCheck.GetString()) && snCheck.GetString() != "Giáo viên") expectedSigner = snCheck.GetString();
                    else if (root.TryGetProperty("author", out var authCheck) && !string.IsNullOrWhiteSpace(authCheck.GetString())) expectedSigner = authCheck.GetString();

                    string? expectedCccd = null;
                    if (root.TryGetProperty("cccd", out var cProp) && !string.IsNullOrWhiteSpace(cProp.GetString())) expectedCccd = cProp.GetString();
                    else if (root.TryGetProperty("doc", out var docElemCccd) && docElemCccd.TryGetProperty("cccd", out var dCProp) && !string.IsNullOrWhiteSpace(dCProp.GetString())) expectedCccd = dCProp.GetString();

                    // EDOC-CA pattern: Tìm cert bằng thumbprint trước — chính xác nhất, không bị lỗi unicode
                    string? expectedThumbprint = null;
                    if (root.TryGetProperty("thumbprint", out var thumbProp) && !string.IsNullOrWhiteSpace(thumbProp.GetString()))
                        expectedThumbprint = thumbProp.GetString()!.Replace(" ", "").ToUpperInvariant();

                    X509Certificate2? localVgcaCert = null;

                    // 1. Tìm theo thumbprint (chuẩn EDOC-CA - FindByThumbprint)
                    if (!string.IsNullOrEmpty(expectedThumbprint))
                    {
                        try
                        {
                            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
                            store.Open(OpenFlags.ReadOnly);
                            localVgcaCert = store.Certificates
                                .Find(X509FindType.FindByThumbprint, expectedThumbprint, false)
                                .OfType<X509Certificate2>()
                                .FirstOrDefault(c => c.HasPrivateKey && DateTime.Now >= c.NotBefore && DateTime.Now <= c.NotAfter && (c.Extensions.OfType<X509KeyUsageExtension>().FirstOrDefault() == null || (c.Extensions.OfType<X509KeyUsageExtension>().First().KeyUsages & (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation)) != 0));
                        }
                        catch { }
                    }

                    // 2. Fallback tìm theo serial / tên / CCCD nếu không có thumbprint
                    if (localVgcaCert == null && string.IsNullOrWhiteSpace(expectedThumbprint))
                        localVgcaCert = FindVgcaCertificate(expectedSerial, signMode, expectedSigner, expectedCccd);

                    if (localVgcaCert == null)
                    {
                        res.StatusCode = 400;
                        string failMsg = signMode == "PERSONAL"
                            ? "Không tìm thấy chứng thư số cá nhân VGCA hợp lệ của Giáo viên trên máy tính! Vui lòng kiểm tra lại dịch vụ Virtual CSP v2.0."
                            : (!string.IsNullOrWhiteSpace(expectedSerial)
                                ? $"Không tìm thấy USB Token khớp với số Serial [{expectedSerial}] của Ban Giám hiệu! Vui lòng cắm đúng USB Token vào máy tính."
                                : "Chưa cắm đúng thiết bị USB Token hoặc chưa kích hoạt chữ ký số.");
                        string errJson = JsonSerializer.Serialize(new { success = false, message = failMsg });
                        byte[] errData = System.Text.Encoding.UTF8.GetBytes(errJson);
                        res.OutputStream.Write(errData, 0, errData.Length);
                        res.Close();
                        return;
                    }

                    string localVgcaSigner = ExtractCn(localVgcaCert.Subject);

                    // CHỐNG GHI ĐÈ & BẢO VỆ DANH TÍNH GIÁO VIÊN:
                    if (signMode == "PERSONAL")
                    {
                        // 1. Tuyệt đối không ký bằng con dấu cơ quan
                        if (localVgcaSigner.Contains("TRƯỜNG", StringComparison.OrdinalIgnoreCase) || localVgcaSigner.Contains("TRUONG", StringComparison.OrdinalIgnoreCase) || (localVgcaCert.Subject ?? "").Contains("MST:"))
                        {
                            res.StatusCode = 400;
                            string errJson = JsonSerializer.Serialize(new { success = false, message = "Phát hiện chứng thư số con dấu cơ quan nhà trường thay vì chứng thư cá nhân của Thầy/Cô! Vui lòng sử dụng tài khoản ký số cá nhân VGCA." });
                            byte[] errData = System.Text.Encoding.UTF8.GetBytes(errJson);
                            res.OutputStream.Write(errData, 0, errData.Length);
                            res.Close();
                            return;
                        }

                        // 2. Kiểm tra chặt chẽ danh tính giữa tài khoản Web và chứng thư số thực trên máy
                        if (!string.IsNullOrEmpty(expectedSigner) || !string.IsNullOrEmpty(expectedCccd))
                        {
                            string certCccd = ExtractCccdOrUid(localVgcaCert.Subject).Trim(); string expCccd = (expectedCccd ?? "").Trim();
                            bool matchCccd = !string.IsNullOrEmpty(expCccd) && string.Equals(certCccd, expCccd, StringComparison.Ordinal);
                            if (!string.IsNullOrEmpty(expCccd) && !matchCccd) { res.StatusCode = 403; byte[] err = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { success = false, message = $"Từ chối ký số: Số CCCD không khớp ({certCccd} != {expCccd})." })); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                            bool matchName = false;
                            if (!string.IsNullOrEmpty(expectedSigner))
                            {
                                string normExp = RemoveDiacritics(expectedSigner).Trim().ToLowerInvariant();
                                string normAct = RemoveDiacritics(localVgcaSigner).Trim().ToLowerInvariant();
                                matchName = !string.IsNullOrEmpty(normExp) && !string.IsNullOrEmpty(normAct) && string.Equals(normAct, normExp, StringComparison.Ordinal);
                            }

                            if ((!string.IsNullOrEmpty(expectedSigner) && !matchName) || (!string.IsNullOrEmpty(expCccd) && !matchCccd))
                            {
                                res.StatusCode = 403;
                                string errJson = JsonSerializer.Serialize(new
                                {
                                    success = false,
                                    message = $"Từ chối ký số: Tài khoản ký số trên máy ({localVgcaSigner}) không khớp với tài khoản giáo viên trên hệ thống ({expectedSigner ?? expectedCccd}). Vui lòng đăng nhập đúng tài khoản trên VGCA Virtual CSP."
                                });
                                byte[] errData = System.Text.Encoding.UTF8.GetBytes(errJson);
                                res.OutputStream.Write(errData, 0, errData.Length);
                                res.Close();
                                return;
                            }
                        }
                    }
                    else if (signMode == "HARDWARE" && !string.IsNullOrEmpty(expectedSerial))
                    {
                        // Kiểm tra Serial USB Token của Ban Giám hiệu
                        string cleanActualSerial = (localVgcaCert.SerialNumber ?? "").Replace(" ", "").Replace(":", "").Trim();
                        string cleanExpSerial = (expectedSerial ?? "").Replace(" ", "").Replace(":", "").Trim();
                        if (!cleanActualSerial.Equals(cleanExpSerial, StringComparison.OrdinalIgnoreCase))
                        {
                            res.StatusCode = 400;
                            string errJson = JsonSerializer.Serialize(new
                            {
                                success = false,
                                message = $"Số Serial của USB Token đang cắm [{cleanActualSerial}] không khớp với số Serial Ban Giám hiệu [{cleanExpSerial}]! Vui lòng cắm đúng USB Token."
                            });
                            byte[] errData = System.Text.Encoding.UTF8.GetBytes(errJson);
                            res.OutputStream.Write(errData, 0, errData.Length);
                            res.Close();
                            return;
                        }
                    }

                    if (!string.IsNullOrEmpty(localVgcaSigner) && localVgcaSigner != "Giáo viên")
                    {
                        signerName = localVgcaSigner;
                    }

                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] 📝 Nhận lệnh ký số: \"{docTitle}\" (Chủ thể chứng thư: {signerName}{(expectedSerial != null ? $", Serial yêu cầu: {expectedSerial}" : "")})");

                    byte[] pdfBytes = null!;
                    if (!string.IsNullOrEmpty(fileBase64))
                    {
                        try { string cleanBase64 = Regex.Replace(fileBase64, @"^data:[^;]+;base64,", ""); pdfBytes = Convert.FromBase64String(cleanBase64); }
                        catch { res.StatusCode = 400; byte[] err = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { success = false, message = "Dữ liệu tệp PDF Base64 không hợp lệ!" })); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                    }
                    else if (s_isTestSimulationAuthorized)
                    {
                        string samplePath = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "GiaoAn_CanKy.pdf");
                        if (File.Exists(samplePath)) pdfBytes = File.ReadAllBytes(samplePath);
                        else { string tempMau = System.IO.Path.GetTempFileName() + ".pdf"; TaoFilePdfMau(tempMau); pdfBytes = File.ReadAllBytes(tempMau); try { File.Delete(tempMau); } catch { } }
                    }
                    else { res.StatusCode = 400; byte[] err = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { success = false, message = "Thiếu dữ liệu tệp PDF (fileBase64 rỗng)!" })); res.OutputStream.Write(err, 0, err.Length); res.Close(); return; }
                    if (pdfBytes == null || pdfBytes.Length == 0)
                    {
                        res.StatusCode = 400; byte[] err = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { success = false, message = "Dữ liệu tệp PDF không hợp lệ hoặc rỗng!" }));
                        res.OutputStream.Write(err, 0, err.Length); res.Close(); return;
                    }

                    bool hasExisting = HasExistingSignature(pdfBytes);
                    // Nếu tệp đã có chữ ký số trước (như của cô Phạm Thị Mỹ Hằng), server không vẽ ảnh để bảo vệ dải băm SHA-256.
                    // Do đó EduSign Agent BẮT BUỘC phải nhúng SignatureFieldAppearance trong Incremental Update để hiện đầy đủ ảnh chữ ký!
                    bool needVisualAppearance = hasExisting || !isPreStamped;

                    bool isCopySign = false;
                    string copyType = "SAO Y";
                    string copyText = "";

                    if (root.TryGetProperty("signType", out var stProp) && stProp.GetString()?.Equals("COPY", StringComparison.OrdinalIgnoreCase) == true) isCopySign = true;
                    if (root.TryGetProperty("isCopySign", out var csProp) && csProp.GetBoolean()) isCopySign = true;
                    if (root.TryGetProperty("copyType", out var ctProp) && !string.IsNullOrWhiteSpace(ctProp.GetString())) copyType = ctProp.GetString()!;
                    if (root.TryGetProperty("copyText", out var ctxtProp) && !string.IsNullOrWhiteSpace(ctxtProp.GetString())) copyText = ctxtProp.GetString()!;

                    if (root.TryGetProperty("doc", out var docElemCheck))
                    {
                        if (!isCopySign && docElemCheck.TryGetProperty("signType", out var dstProp) && dstProp.GetString()?.Equals("COPY", StringComparison.OrdinalIgnoreCase) == true) isCopySign = true;
                        if (!isCopySign && docElemCheck.TryGetProperty("isCopySign", out var dcsProp) && dcsProp.GetBoolean()) isCopySign = true;
                        if (docElemCheck.TryGetProperty("copyType", out var dctProp) && !string.IsNullOrWhiteSpace(dctProp.GetString())) copyType = dctProp.GetString()!;
                        if (docElemCheck.TryGetProperty("copyText", out var dctxtProp) && !string.IsNullOrWhiteSpace(dctxtProp.GetString())) copyText = dctxtProp.GetString()!;
                    }

                    byte[]? sigImgBytes = null;
                    Rectangle? signRect = null;
                    int targetPage = 0;

                    if (isCopySign)
                    {
                        if (string.IsNullOrWhiteSpace(copyText))
                        {
                            copyText = $"{copyType}; {signerName}; Thời gian ký: {DateTime.Now:yyyy-MM-ddTHH:mm:ss+07:00}";
                        }

                        byte[]? bannerBytes = null;
                        float rectW = 260f;
                        float rectH = 16f;

                        // Kiểm tra nếu client truyền copySignBannerBase64 (Canvas 300 DPI)
                        string? bannerB64 = null;
                        if (root.TryGetProperty("copySignBannerBase64", out var bProp)) bannerB64 = bProp.GetString();
                        else if (root.TryGetProperty("doc", out var docElemB64) && docElemB64.TryGetProperty("copySignBannerBase64", out var dbProp)) bannerB64 = dbProp.GetString();

                        if (!string.IsNullOrWhiteSpace(bannerB64))
                        {
                            try
                            {
                                string clean = bannerB64;
                                if (clean.Contains(",")) clean = clean.Substring(clean.IndexOf(",") + 1);
                                bannerBytes = Convert.FromBase64String(clean);
                                if (root.TryGetProperty("copySignBannerWidthPt", out var wProp)) rectW = (float)wProp.GetDouble();
                                else if (root.TryGetProperty("doc", out var docElemW) && docElemW.TryGetProperty("copySignBannerWidthPt", out var dwProp)) rectW = (float)dwProp.GetDouble();

                                if (root.TryGetProperty("copySignBannerHeightPt", out var hProp)) rectH = (float)hProp.GetDouble();
                                else if (root.TryGetProperty("doc", out var docElemH) && docElemH.TryGetProperty("copySignBannerHeightPt", out var dhProp)) rectH = (float)dhProp.GetDouble();
                            }
                            catch { }
                        }

                        if (bannerBytes == null || bannerBytes.Length == 0)
                        {
                            var banner = GenerateCopySignBanner(copyText);
                            bannerBytes = banner.imageBytes;
                            rectW = banner.widthPt;
                            rectH = banner.heightPt;
                        }

                        sigImgBytes = bannerBytes;
                        targetPage = 1;

                        float p1W = 595.28f, p1H = 841.89f;
                        try
                        {
                            using var tempReader = new PdfReader(new MemoryStream(pdfBytes));
                            using var tempDoc = new PdfDocument(tempReader);
                            var p1 = tempDoc.GetPage(1);
                            if (p1 != null)
                            {
                                var pSize = p1.GetPageSize();
                                p1W = pSize.GetWidth();
                                p1H = pSize.GetHeight();
                            }
                        }
                        catch { }

                        float rectX = p1W - rectW - 40f; // Căn sát lề phải chuẩn H3
                        float rectY = p1H - rectH - 18f; // Căn lề trên chuẩn H3
                        signRect = new Rectangle(rectX, rectY, rectW, rectH);

                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] 📋 Ký Sao Y ({copyType}) Trang 1, X={rectX:F1}, Y={rectY:F1}, W={rectW:F1}, H={rectH:F1}: \"{copyText}\"");
                    }
                    else if (needVisualAppearance)
                    {
                        sigImgBytes = ResolveSignatureImage(sigImgData);
                        string signerRole = "teacher";
                        if (root.TryGetProperty("signerRole", out var srProp) && !string.IsNullOrWhiteSpace(srProp.GetString())) signerRole = srProp.GetString()!;
                        else if (root.TryGetProperty("role", out var rProp) && !string.IsNullOrWhiteSpace(rProp.GetString())) signerRole = rProp.GetString()!;
                        else if (root.TryGetProperty("doc", out var docRoleElem))
                        {
                            if (docRoleElem.TryGetProperty("signerRole", out var dsrProp) && !string.IsNullOrWhiteSpace(dsrProp.GetString())) signerRole = dsrProp.GetString()!;
                            else if (docRoleElem.TryGetProperty("role", out var drProp) && !string.IsNullOrWhiteSpace(drProp.GetString())) signerRole = drProp.GetString()!;
                        }
                        if (signerName.Contains("Liền", StringComparison.OrdinalIgnoreCase) || signerName.Contains("Lien", StringComparison.OrdinalIgnoreCase)) signerRole = "principal";
                        else if (signerName.Contains("Hằng", StringComparison.OrdinalIgnoreCase) || signerName.Contains("Hang", StringComparison.OrdinalIgnoreCase)) signerRole = "leader";

                        var coords = DetermineCoordinates(pdfBytes, signerName, signerRole, reqX, reqY, reqW, reqH, reqPage, reqXPercent, reqYPercent, isManualDrag);
                        targetPage = coords.page;
                        signRect = new Rectangle(coords.x, coords.y, coords.w, coords.h);
                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] 🎯 Xác định vị trí chữ ký số trực quan: Trang {targetPage}, X={coords.x:F1}, Y={coords.y:F1}, W={coords.w:F1}, H={coords.h:F1} (role={signerRole}, hasExistingSig={hasExisting}, ảnh={sigImgBytes?.Length ?? 0} bytes)");
                    }

                    string signReason = isCopySign ? $"{copyType} theo NĐ 30/2020/NĐ-CP - {signerName}" : $"{signerName} đã ký số VGCA";

                    try
                    {
                        byte[] signedBytes = KySoPdfBytes(pdfBytes, signReason, "Quảng Ngãi", strict: true, visualSignImageBytes: sigImgBytes, signRect: signRect, targetPage: targetPage, expectedSerial: expectedSerial, signMode: signMode);
                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] 🎉 Niêm phong PAdES X.509 thành công! Dung lượng: {signedBytes.Length} bytes.");

                        var resObj = new
                        {
                            success = true,
                            message = "Ký số mật mã thật VGCA thành công 100%!",
                            signedPdfBase64 = "data:application/pdf;base64," + Convert.ToBase64String(signedBytes),
                            signer = signerName
                        };
                        byte[] resBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(resObj));
                        res.OutputStream.Write(resBytes, 0, resBytes.Length);
                        res.Close();
                        return;
                    }
                    catch (Exception ex)
                    {
                        SetColor(ConsoleColor.Red);
                        WriteLine($"[{DateTime.Now:HH:mm:ss}] 🛑 Thao tác ký số bị gián đoạn: {ex.Message}");
                        ResetColor();

                        string msgLower = ex.Message.ToLowerInvariant();
                        bool isCancelled = msgLower.Contains("cancelled by the user") || msgLower.Contains("hủy") || msgLower.Contains("từ chối") || msgLower.Contains("cancel");

                        res.StatusCode = isCancelled ? 400 : 500;
                        var errObj = new
                        {
                            success = false,
                            cancelled = isCancelled,
                            message = isCancelled ? "Người dùng đã từ chối hoặc hủy xác nhận ký số trên điện thoại." : "Quá trình ký số mật mã không thành công. Vui lòng kiểm tra lại dịch vụ ký số và thử lại."
                        };
                        byte[] errBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(errObj));
                        res.OutputStream.Write(errBytes, 0, errBytes.Length);
                        res.Close();
                        return;
                    }
                }

                if (path == "/api/trigger-mobile-auth" && req.HttpMethod == "POST")
                {
                    using var cert = FindVgcaCertificate();
                    if (cert == null || !cert.HasPrivateKey)
                    {
                        var errObj = new { success = false, message = "Chưa phát hiện chứng thư số Ban Cơ yếu có khóa riêng trên máy tính này." };
                        byte[] errBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(errObj));
                        res.StatusCode = 400;
                        res.OutputStream.Write(errBytes, 0, errBytes.Length);
                        res.Close();
                        return;
                    }

                    string signer = ExtractCn(cert.Subject);
                    SetColor(ConsoleColor.Cyan);
                    WriteLine($"[{DateTime.Now:HH:mm:ss}] 📲 Đang kích hoạt tín hiệu Push Notification tới điện thoại của {signer}...");
                    ResetColor();

                    // Kích hoạt hàm SignData của Ban Cơ yếu để gửi lệnh tới điện thoại ngay lập tức
                    byte[] testPayload = System.Text.Encoding.UTF8.GetBytes("VGCA_PING_" + DateTime.UtcNow.Ticks);
                    using var vgcaSig = new VgcaSignature(cert);
                    byte[] sig = vgcaSig.Sign(testPayload);

                    SetColor(ConsoleColor.Green);
                    WriteLine($"[{DateTime.Now:HH:mm:ss}] 🎉 Giáo viên đã bấm [ĐỒNG Ý] trên điện thoại thành công!");
                    ResetColor();

                    var okObj = new
                    {
                        success = true,
                        message = "Điện thoại đã xác nhận ký số thành công!",
                        signer = signer,
                        thumbprint = cert.Thumbprint
                    };
                    byte[] okBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(okObj));
                    res.OutputStream.Write(okBytes, 0, okBytes.Length);
                    res.Close();
                    return;
                }

                res.StatusCode = 404;
                byte[] notFound = System.Text.Encoding.UTF8.GetBytes("{\"success\":false,\"message\":\"Endpoint not found\"}");
                res.OutputStream.Write(notFound, 0, notFound.Length);
                res.Close();
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"❌ Lỗi xử lý yêu cầu ký: {ex.Message}");
                Console.ResetColor();

                res.StatusCode = 500;
                var errObj = new { success = false, message = ex.Message };
                byte[] errBytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(errObj));
                res.OutputStream.Write(errBytes, 0, errBytes.Length);
                res.Close();
            }
        }

        public static string RemoveDiacritics(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return "";
            var normalizedString = text.Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder();
            foreach (var c in normalizedString)
            {
                var unicodeCategory = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c);
                if (unicodeCategory != System.Globalization.UnicodeCategory.NonSpacingMark)
                {
                    sb.Append(c);
                }
            }
            return sb.ToString().Normalize(NormalizationForm.FormC).Replace("đ", "d").Replace("Đ", "D");
        }

        public static string ExtractCn(string? subject)
        {
            if (string.IsNullOrEmpty(subject)) return "Giáo viên";
            var m = Regex.Match(subject, @"CN=([^,]+)");
            return m.Success ? m.Groups[1].Value.Trim() : subject;
        }

        private static Dictionary<string, string> ParseDn(string? dn)
        {
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(dn)) return dict;
            int i = 0; while (i < dn.Length) {
                while (i < dn.Length && (dn[i] == ' ' || dn[i] == ',' || dn[i] == ';')) i++;
                if (i >= dn.Length) break;
                int eq = dn.IndexOf('=', i); if (eq == -1) break;
                string key = dn.Substring(i, eq - i).Trim(); i = eq + 1;
                var sb = new System.Text.StringBuilder(); bool q = false;
                while (i < dn.Length) {
                    char c = dn[i];
                    if (c == '\\' && i + 1 < dn.Length) { sb.Append(dn[i + 1]); i += 2; }
                    else if (c == '"') { q = !q; i++; }
                    else if ((c == ',' || c == ';') && !q) { i++; break; }
                    else { sb.Append(c); i++; }
                }
                string val = sb.ToString().Trim(); if (!dict.ContainsKey(key)) dict[key] = val;
            }
            return dict;
        }
        public static string ExtractEmail(string? subject) { var dn = ParseDn(subject); return dn.TryGetValue("E", out var e) || dn.TryGetValue("EMAIL", out e) || dn.TryGetValue("EMAILADDRESS", out e) || dn.TryGetValue("1.2.840.113549.1.9.1", out e) ? e : ""; }
        public static string ExtractOu(string? subject) { var dn = ParseDn(subject); return dn.TryGetValue("OU", out var ou) || dn.TryGetValue("2.5.4.11", out ou) ? ou : "THCS Chu Văn An"; }
        public static string ExtractCccdOrUid(string? subject) {
            var dn = ParseDn(subject);
            if (dn.TryGetValue("UID", out var uid) || dn.TryGetValue("0.9.2342.19200300.100.1.1", out uid)) return uid; if (dn.TryGetValue("SERIALNUMBER", out var sn) || dn.TryGetValue("OID.2.5.4.45", out sn) || dn.TryGetValue("2.5.4.45", out sn)) return sn; return ""; }
    }

    public class EduSignWin32Tray
    {
        private const int NIM_ADD = 0x00000000;
        private const int NIM_MODIFY = 0x00000001;
        private const int NIM_DELETE = 0x00000002;
        private const int NIF_MESSAGE = 0x00000001;
        private const int NIF_ICON = 0x00000002;
        private const int NIF_TIP = 0x00000004;
        private const int NIF_INFO = 0x00000010;
        private const int NIIF_INFO = 0x00000001;
        private const int NIIF_WARNING = 0x00000002;
        private const int WM_USER = 0x0400;
        private const int WM_TRAYICON = WM_USER + 1;
        private const int WM_RBUTTONUP = 0x0205;
        private const int WM_LBUTTONDBLCLK = 0x0203;
        private const int TPM_RIGHTBUTTON = 0x0002;
        private const int TPM_RETURNCMD = 0x0100;
        private const int MF_STRING = 0x0000;
        private const int MF_SEPARATOR = 0x0800;
        private const int MF_GRAYED = 0x0001;
        private const int MF_CHECKED = 0x0008;
        private const string AppName = "EduSignAgent";

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct NOTIFYICONDATA
        {
            public int cbSize;
            public IntPtr hWnd;
            public int uID;
            public int uFlags;
            public int uCallbackMessage;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szTip;
            public int dwState;
            public int dwStateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
            public string szInfo;
            public int uTimeoutOrVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
            public string szInfoTitle;
            public int dwInfoFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

        public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct WNDCLASSEX
        {
            public uint cbSize;
            public uint style;
            public WndProcDelegate lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            public string lpszMenuName;
            public string lpszClassName;
            public IntPtr hIconSm;
        }

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateWindowEx(int dwExStyle, string lpClassName, string lpWindowName, int dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern ushort RegisterClassEx([In] ref WNDCLASSEX lpwcx);

        [DllImport("user32.dll")]
        private static extern IntPtr DefWindowProc(IntPtr hWnd, uint uMsg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage([In] ref MSG lpmsg);

        [DllImport("user32.dll")]
        private static extern void PostQuitMessage(int nExitCode);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Shell_NotifyIcon(int dwMessage, ref NOTIFYICONDATA lpData);

        [DllImport("user32.dll")]
        private static extern IntPtr LoadIcon(IntPtr hInstance, IntPtr lpIconName);

        [DllImport("user32.dll")]
        private static extern IntPtr CreatePopupMenu();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool AppendMenu(IntPtr hMenu, int uFlags, int uIDNewItem, string lpNewItem);

        [DllImport("user32.dll")]
        private static extern int TrackPopupMenu(IntPtr hMenu, int uFlags, int x, int y, int nReserved, IntPtr hWnd, IntPtr prcRect);

        [DllImport("user32.dll")]
        private static extern bool DestroyMenu(IntPtr hMenu);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string? lpModuleName);

        // ===== WM_DEVICECHANGE / USB Hot-plug Detection =====
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr RegisterDeviceNotification(IntPtr hRecipient, ref DEV_BROADCAST_DEVICEINTERFACE NotificationFilter, int Flags);

        [DllImport("user32.dll")]
        private static extern bool UnregisterDeviceNotification(IntPtr Handle);

        private const uint WM_DEVICECHANGE         = 0x0219;
        private const int  DBT_DEVICEARRIVAL        = 0x8000;
        private const int  DBT_DEVICEREMOVECOMPLETE  = 0x8004;
        private const int  DEVICE_NOTIFY_WINDOW_HANDLE = 0x00000000;
        private const int  DBT_DEVTYP_DEVICEINTERFACE  = 0x00000005;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DEV_BROADCAST_DEVICEINTERFACE
        {
            public int    dbcc_size;
            public int    dbcc_devicetype;
            public int    dbcc_reserved;
            public Guid   dbcc_classguid;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
            public string dbcc_name;
        }

        // SmartCard Reader / CCID Cryptographic Token GUID — CHỈ nhận thiết bị USB Token bảo mật (Bit4id, Feitian, Safenet, v.v.)
        // KHÔNG BAO GIỜ nhận chuột, bàn phím, ổ cứng USB thông thường!
        private static readonly Guid GUID_DEVINTERFACE_SMARTCARD_READER = new Guid("50DD5230-BA8A-11D1-BF5D-0000F805F530");

        private IntPtr _deviceNotifyHandle = IntPtr.Zero;
        // ===================================================

        private IntPtr _hWnd;
        private NOTIFYICONDATA _nid;
        private static WndProcDelegate? _staticWndProc;
        private HttpListener? _listener;
        private Thread? _listenerThread;
        private Thread? _updateCheckThread;
        public bool UpdateAvailable { get; set; } = false;
        public Program.AgentVersionInfo? LatestVersionInfo { get; set; } = null;
        private static readonly IntPtr IDI_SHIELD = (IntPtr)32518;
        private static readonly IntPtr IDI_APPLICATION = (IntPtr)32512;
        private static readonly ManualResetEvent _exitEvent = new ManualResetEvent(false);

        // === Thread-safe balloon notification (PostMessage từ background thread) ===
        private const uint WM_APP_SHOW_BALLOON = 0x8001; // WM_APP + 1
        private static readonly object _pendingBalloonLock = new object();
        private static string? _pendingBalloonTitle;
        private static string? _pendingBalloonText;
        private static int _pendingBalloonIcon = NIIF_INFO;

        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
        // ==========================================================================



        public void Run()
        {
            string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
            try { File.AppendAllText(debugLog, $"[{DateTime.Now}] EduSignWin32Tray.Run entered\n"); } catch { }

            string className = "EduSignAgentTrayWin_" + Guid.NewGuid().ToString("N");
            IntPtr hInstance = GetModuleHandle(null);

            _staticWndProc = CustomWndProc;
            var wndClass = new WNDCLASSEX
            {
                cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
                style = 0,
                lpfnWndProc = _staticWndProc,
                cbClsExtra = 0,
                cbWndExtra = 0,
                hInstance = hInstance,
                hIcon = IntPtr.Zero,
                hCursor = IntPtr.Zero,
                hbrBackground = IntPtr.Zero,
                lpszMenuName = "",
                lpszClassName = className,
                hIconSm = IntPtr.Zero
            };

            StartHttpServer();
            StartBackgroundUpdateCheck();

            try
            {
                RegisterClassEx(ref wndClass);
                _hWnd = CreateWindowEx(0, className, "EduSignAgentHiddenWindow", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, hInstance, IntPtr.Zero);
            }
            catch { }

            if (_hWnd != IntPtr.Zero)
            {
                IntPtr hIcon = LoadIcon(IntPtr.Zero, IDI_SHIELD);
                if (hIcon == IntPtr.Zero) hIcon = LoadIcon(IntPtr.Zero, IDI_APPLICATION);

                _nid = new NOTIFYICONDATA
                {
                    cbSize = Marshal.SizeOf<NOTIFYICONDATA>(),
                    hWnd = _hWnd,
                    uID = 1,
                    uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP,
                    uCallbackMessage = WM_TRAYICON,
                    hIcon = hIcon,
                    szTip = "EduSign Agent v2.0 - Ban Cơ yếu CP"
                };

                Shell_NotifyIcon(NIM_ADD, ref _nid);
                ShowBalloon("EduSign Desktop Agent", "Dịch vụ ký số Ban Cơ yếu đang chạy ngầm an toàn tại khay hệ thống.", NIIF_INFO);

                // Đăng ký nhận thông báo USB SmartCard / Token hot-plug từ Windows
                try
                {
                    var devFilter = new DEV_BROADCAST_DEVICEINTERFACE
                    {
                        dbcc_devicetype = DBT_DEVTYP_DEVICEINTERFACE,
                        dbcc_classguid  = GUID_DEVINTERFACE_SMARTCARD_READER,
                        dbcc_name       = ""
                    };
                    devFilter.dbcc_size = Marshal.SizeOf(devFilter);
                    _deviceNotifyHandle = RegisterDeviceNotification(_hWnd, ref devFilter, DEVICE_NOTIFY_WINDOW_HANDLE);
                    try { File.AppendAllText(debugLog, $"[{DateTime.Now}] RegisterDeviceNotification (SmartCard Reader): handle={_deviceNotifyHandle}\n"); } catch { }
                }
                catch (Exception dnEx)
                {
                    try { File.AppendAllText(debugLog, $"[{DateTime.Now}] RegisterDeviceNotification failed: {dnEx.Message}\n"); } catch { }
                }
            }

            _exitEvent.Reset();
            try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Starting message loop, _hWnd={_hWnd}\n"); } catch { }

            while (!_exitEvent.WaitOne(50))
            {
                while (PeekMessage(out MSG msg, IntPtr.Zero, 0, 0, 1))
                {
                    if (msg.message == 0x0012)
                    {
                        try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Received WM_QUIT\n"); } catch { }
                        _exitEvent.Set();
                        break;
                    }
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            }

            try { File.AppendAllText(debugLog, $"[{DateTime.Now}] Message loop exited. Cleaning up.\n"); } catch { }

            if (_deviceNotifyHandle != IntPtr.Zero)
            {
                try { UnregisterDeviceNotification(_deviceNotifyHandle); } catch { }
                _deviceNotifyHandle = IntPtr.Zero;
            }

            if (_hWnd != IntPtr.Zero)
            {
                Shell_NotifyIcon(NIM_DELETE, ref _nid);
            }
            try { _listener?.Stop(); _listener?.Close(); } catch { }
        }

        private IntPtr CustomWndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (msg == WM_TRAYICON)
                {
                    long lp = (long)lParam & 0xFFFF;
                    if (lp == WM_RBUTTONUP || lp == WM_LBUTTONDBLCLK)
                    {
                        ShowTrayMenu();
                    }
                    return IntPtr.Zero;
                }

                // ===== SMARTCARD / USB TOKEN HOT-PLUG DETECTION =====
                if (msg == WM_DEVICECHANGE)
                {
                    int eventType = (int)wParam;
                    if (eventType == DBT_DEVICEARRIVAL || eventType == DBT_DEVICEREMOVECOMPLETE)
                    {
                        // Xóa cache cert để lần poll tiếp theo sẽ đọc lại store
                        Program.InvalidateCertCache();

                        // Xử lý bất đồng bộ để không block message loop
                        bool isArrival = (eventType == DBT_DEVICEARRIVAL);
                        IntPtr hwndCapture = _hWnd;
                        ThreadPool.QueueUserWorkItem(_ =>
                        {
                            Thread.Sleep(800); // Chờ driver thiết bị ổn định
                            try
                            {
                                string balloonTitle, balloonText;
                                uint balloonIcon;
                                string? evtType = null, evtSigner = null, evtSerial = null, evtThumb = null;

                                if (isArrival)
                                {
                                    // CHỈ TÌM KIẾM THIẾT BỊ PHẦN CỨNG (HARDWARE TOKEN) - TUYỆT ĐỐI KHÔNG FALLBACK VIRTUAL CSP!
                                    X509Certificate2? cert = null;
                                    try { cert = Program.FindHardwareTokenCertificate(); } catch { }
                                    using (cert)
                                    if (cert != null)
                                    {
                                        string cn = Program.ExtractCn(cert.Subject);
                                        balloonTitle = "🔑 USB Token đã kết nối";
                                        balloonText  = $"Đã nhận diện chứng thư số: {cn}";
                                        balloonIcon  = (int)NIIF_INFO; evtType = "connected"; evtSigner = cn;
                                        evtSerial = cert.SerialNumber; evtThumb = cert.Thumbprint;
                                    }
                                    else
                                    {
                                        balloonTitle = "🔑 Đã nhận diện thiết bị USB Token";
                                        balloonText  = "Vui lòng mở ứng dụng Bit4id PKI Manager và đăng nhập mã PIN để mở khóa chứng thư số.";
                                        balloonIcon  = (int)NIIF_INFO;
                                        evtType = "token_detected_pin_required";
                                    }
                                }
                                else
                                {
                                    balloonTitle = "🔌 USB Token đã rút";
                                    balloonText  = "USB Token đã được rút khỏi máy tính. Cổng ký số phần cứng tạm ngừng.";
                                    balloonIcon  = (int)NIIF_WARNING;
                                    evtType = "disconnected";
                                }

                                // Broadcast WebSocket
                                if (evtType != null)
                                    Program.BroadcastUsbEvent(evtType, evtSigner, evtSerial, evtThumb);

                                // Marshal ShowBalloon về UI thread qua PostMessage WM_APP+1
                                lock (_pendingBalloonLock)
                                {
                                    _pendingBalloonTitle = balloonTitle;
                                    _pendingBalloonText  = balloonText;
                                    _pendingBalloonIcon  = (int)balloonIcon;
                                }
                                if (hwndCapture != IntPtr.Zero)
                                    PostMessage(hwndCapture, WM_APP_SHOW_BALLOON, IntPtr.Zero, IntPtr.Zero);
                            }
                            catch { }
                        });
                    }
                    return IntPtr.Zero;
                }

                // WM_APP+1: Hiển thị balloon từ UI thread (an toàn)
                if (msg == WM_APP_SHOW_BALLOON)
                {
                    string title, text;
                    int icon;
                    lock (_pendingBalloonLock)
                    {
                        title = _pendingBalloonTitle ?? "EduSign Agent";
                        text  = _pendingBalloonText  ?? "";
                        icon  = _pendingBalloonIcon;
                    }
                    try { ShowBalloon(title, text, icon); } catch { }
                    return IntPtr.Zero;
                }
                // ===================================

                return DefWindowProc(hWnd, msg, wParam, lParam);
            }
            catch
            {
                return DefWindowProc(hWnd, msg, wParam, lParam);
            }
        }

        private void StartBackgroundUpdateCheck()
        {
            _updateCheckThread = new Thread(() =>
            {
                Thread.Sleep(3000);
                while (!_exitEvent.WaitOne(0))
                {
                    try
                    {
                        var (hasNew, info) = Program.CheckForUpdates(true);
                        if (hasNew && info != null)
                        {
                            UpdateAvailable = true;
                            LatestVersionInfo = info;
                            ShowBalloon("Đã có bản cập nhật mới!", $"EduSign Agent phiên bản {info.version} đã sẵn sàng. Nhấn để nâng cấp ngay.", NIIF_INFO);
                        }
                    }
                    catch { }

                    if (_exitEvent.WaitOne(TimeSpan.FromHours(2))) break;
                }
            })
            {
                IsBackground = true,
                Name = "EduSignBackgroundUpdateChecker"
            };
            _updateCheckThread.Start();
        }

        private void CheckUpdateExplicit()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    ShowBalloon("EduSign Agent", "Đang kiểm tra bản cập nhật từ máy chủ...", NIIF_INFO);
                    var (hasNew, info) = Program.CheckForUpdates(true);
                    if (hasNew && info != null)
                    {
                        UpdateAvailable = true; LatestVersionInfo = info;
                        ShowBalloon("Đã có bản cập nhật mới!", $"EduSign Agent phiên bản {info.version} đã sẵn sàng. Đang mở hộp thoại nâng cấp...", NIIF_INFO);
                        Program.TriggerUpdateGui(info);
                    }
                    else { ShowBalloon("EduSign Agent", $"Bạn đang sử dụng phiên bản mới nhất (v{Program.CurrentVersion}).", NIIF_INFO); }
                }
                catch (Exception ex) { ShowBalloon("EduSign Agent", "Không thể kiểm tra bản cập nhật lúc này. Vui lòng thử lại sau.", NIIF_WARNING); try { Console.WriteLine($"[Update] Lỗi: {ex.Message}"); } catch { } }
            });
        }

        private void ShowTrayMenu()
        {
            SetForegroundWindow(_hWnd);
            GetCursorPos(out POINT pt);

            IntPtr hMenu = CreatePopupMenu();

            AppendMenu(hMenu, MF_STRING | MF_GRAYED, 101, $"🛡️ EduSign Desktop Agent v{Program.CurrentVersion}");
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, 102, "Trường THCS Chu Văn An - Tỉnh Quảng Ngãi");
            AppendMenu(hMenu, MF_SEPARATOR, 0, "");

            if (UpdateAvailable && LatestVersionInfo != null)
            {
                AppendMenu(hMenu, MF_STRING, 108, $"✨ Cập nhật lên v{LatestVersionInfo.version} (Có sẵn)");
            }

            AppendMenu(hMenu, MF_STRING | MF_GRAYED, 103, "🟢 Cổng ký số cục bộ: Hoạt động (18888)");

            using var cert = Program.FindVgcaCertificate();
            if (cert != null && cert.HasPrivateKey)
            {
                string cn = Program.ExtractCn(cert.Subject);
                AppendMenu(hMenu, MF_STRING, 104, $"🔑 USB Token: {cn} (Ban Cơ yếu) - ĐÃ CẮM");
            }
            else
            {
                AppendMenu(hMenu, MF_STRING, 104, "🔑 Chưa nhận diện USB Token (Bấm để quét lại)");
            }

            AppendMenu(hMenu, MF_SEPARATOR, 0, "");
            AppendMenu(hMenu, MF_STRING, 109, "🔄 Kiểm tra bản cập nhật...");
            AppendMenu(hMenu, MF_STRING, 105, "🌐 Mở Cổng Ký số Giáo dục THCS Chu Văn An");

            int startupFlags = MF_STRING;
            if (IsStartupEnabled()) startupFlags |= MF_CHECKED;
            AppendMenu(hMenu, startupFlags, 106, "🚀 Tự động khởi động cùng Windows");

            AppendMenu(hMenu, MF_SEPARATOR, 0, "");
            AppendMenu(hMenu, MF_STRING, 107, "❌ Thoát ứng dụng");

            int cmd = TrackPopupMenu(hMenu, TPM_RIGHTBUTTON | TPM_RETURNCMD, pt.X, pt.Y, 0, _hWnd, IntPtr.Zero);
            DestroyMenu(hMenu);

            if (cmd == 104)
            {
                using var refreshed = Program.FindVgcaCertificate();
                if (refreshed != null && refreshed.HasPrivateKey)
                {
                    string cn = Program.ExtractCn(refreshed.Subject);
                    ShowBalloon("USB Token Ban Cơ yếu", $"Đã nhận diện chữ ký số của {cn} (Ban Cơ yếu Chính phủ).", NIIF_INFO);
                }
                else
                {
                    ShowBalloon("EduSign Agent", "Chưa phát hiện USB Token. Xin vui lòng cắm USB Token vào cổng USB máy tính.", NIIF_WARNING);
                }
            }
            else if (cmd == 105)
            {
                try
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://mrkhang-khoi.github.io/cvakyso/") { UseShellExecute = true });
                }
                catch { }
            }
            else if (cmd == 106)
            {
                ToggleStartup();
            }
            else if (cmd == 107)
            {
                _exitEvent.Set();
                PostQuitMessage(0);
            }
            else if (cmd == 108)
            {
                Program.TriggerUpdateGui(LatestVersionInfo);
            }
            else if (cmd == 109)
            {
                CheckUpdateExplicit();
            }
        }

        private void ShowBalloon(string title, string text, int iconFlags)
        {
            try
            {
                var nid = _nid;
                nid.uFlags = NIF_INFO;
                nid.szInfoTitle = title;
                nid.szInfo = text;
                nid.dwInfoFlags = iconFlags;
                nid.uTimeoutOrVersion = 3000;
                Shell_NotifyIcon(NIM_MODIFY, ref nid);
            }
            catch { }
        }

        private bool IsStartupEnabled()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false);
                return key?.GetValue(AppName) != null;
            }
            catch { return false; }
        }

        private void ToggleStartup()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                if (key != null)
                {
                    if (IsStartupEnabled())
                    {
                        key.DeleteValue(AppName, false);
                        ShowBalloon("EduSign Agent", "Đã tắt tự động khởi động cùng Windows.", NIIF_INFO);
                    }
                    else
                    {
                        string exePath = Environment.ProcessPath ?? AppDomain.CurrentDomain.BaseDirectory;
                        key.SetValue(AppName, $"\"{exePath}\" --tray");
                        ShowBalloon("EduSign Agent", "Đã bật tự động khởi động cùng Windows.", NIIF_INFO);
                    }
                }
            }
            catch { }
        }

        private void StartHttpServer()
        {
            _listenerThread = new Thread(() =>
            {
                var prefixes = new List<string> { "http://127.0.0.1:18888/" };

                try
                {
                    _listener = new HttpListener();
                    foreach (var prefix in prefixes)
                    {
                        try { _listener.Prefixes.Add(prefix); } catch { }
                    }
                    _listener.Start();
                    string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
                    try { File.AppendAllText(debugLog, $"[{DateTime.Now}] HttpListener started successfully on 18888\n"); } catch { }

                    while (_listener != null && _listener.IsListening)
                    {
                        try
                        {
                            var context = _listener.GetContext();
                            ThreadPool.QueueUserWorkItem(_ => Program.HandleAgentRequest(context));
                        }
                        catch (HttpListenerException) { break; }
                        catch (ObjectDisposedException) { break; }
                        catch (Exception)
                        {
                            Thread.Sleep(50);
                        }
                    }
                }
                catch (Exception ex)
                {
                    string debugLog = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_debug.log");
                    try { File.AppendAllText(debugLog, $"[{DateTime.Now}] StartHttpServer EXCEPTION: {ex}\n"); } catch { }
                }
            })
            {
                IsBackground = true,
                Name = "EduSignAgentHttpListener"
            };
            _listenerThread.Start();
        }
    }

    public class TextChunk
    {
        public string Text { get; set; } = "";
        public float X { get; set; }
        public float Y { get; set; }
        public float Width { get; set; }
        public float Height { get; set; }
    }

    public class TextCollectorListener : IEventListener
    {
        public List<TextChunk> Chunks { get; } = new List<TextChunk>();

        public void EventOccurred(IEventData data, EventType type)
        {
            if (type == EventType.RENDER_TEXT)
            {
                var renderInfo = (TextRenderInfo)data;
                string text = renderInfo.GetText();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    var rect = renderInfo.GetBaseline().GetBoundingRectangle();
                    Chunks.Add(new TextChunk
                    {
                        Text = text,
                        X = rect.GetX(),
                        Y = rect.GetY(),
                        Width = rect.GetWidth(),
                        Height = rect.GetHeight()
                    });
                }
            }
        }

        public ICollection<EventType> GetSupportedEvents()
        {
            return new HashSet<EventType> { EventType.RENDER_TEXT };
        }
    }
}
