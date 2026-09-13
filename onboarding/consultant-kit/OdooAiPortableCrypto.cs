using System;
using System.Security.Cryptography;

public static class OdooAiPortableCrypto
{
    public static byte[] Base64UrlDecode(string value)
    {
        string padded = value.Replace('-', '+').Replace('_', '/');
        switch (padded.Length % 4)
        {
            case 2: padded += "=="; break;
            case 3: padded += "="; break;
        }
        return Convert.FromBase64String(padded);
    }

    public static byte[] WrapKeyOaepSha256(string modulus, string exponent, byte[] key)
    {
        RSAParameters parameters = new RSAParameters {
            Modulus = Base64UrlDecode(modulus),
            Exponent = Base64UrlDecode(exponent)
        };
        using (RSACng rsa = new RSACng())
        {
            rsa.ImportParameters(parameters);
            if (rsa.KeySize != 3072)
                throw new CryptographicException("La clave pública debe ser RSA-3072.");
            return rsa.Encrypt(key, RSAEncryptionPadding.OaepSHA256);
        }
    }

    public static string PublicMaterialFingerprint(string modulus, string exponent)
    {
        byte[] n = Base64UrlDecode(modulus);
        byte[] e = Base64UrlDecode(exponent);
        byte[] material = new byte[n.Length + 1 + e.Length];
        Buffer.BlockCopy(n, 0, material, 0, n.Length);
        Buffer.BlockCopy(e, 0, material, n.Length + 1, e.Length);
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(material);
            Array.Clear(material, 0, material.Length);
            return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
        }
    }

    public static void EncryptAes256Gcm(
        byte[] key, byte[] nonce, byte[] aad, byte[] plaintext,
        out byte[] ciphertext, out byte[] tag)
    {
        if (key == null || key.Length != 32)
            throw new CryptographicException("AES-256 requiere 32 bytes.");
        if (nonce == null || nonce.Length != 12)
            throw new CryptographicException("GCM requiere un nonce de 12 bytes.");

        byte[] h = EncryptBlock(key, new byte[16]);
        byte[] j0 = new byte[16];
        Buffer.BlockCopy(nonce, 0, j0, 0, 12);
        j0[15] = 1;

        ciphertext = new byte[plaintext.Length];
        byte[] counter = (byte[])j0.Clone();
        int offset = 0;
        while (offset < plaintext.Length)
        {
            IncrementCounter(counter);
            byte[] stream = EncryptBlock(key, counter);
            int count = Math.Min(16, plaintext.Length - offset);
            for (int i = 0; i < count; i++)
                ciphertext[offset + i] = (byte)(plaintext[offset + i] ^ stream[i]);
            Array.Clear(stream, 0, stream.Length);
            offset += count;
        }

        byte[] s = GHash(h, aad ?? new byte[0], ciphertext);
        byte[] encryptedJ0 = EncryptBlock(key, j0);
        tag = new byte[16];
        for (int i = 0; i < 16; i++)
            tag[i] = (byte)(encryptedJ0[i] ^ s[i]);

        Array.Clear(h, 0, h.Length);
        Array.Clear(j0, 0, j0.Length);
        Array.Clear(counter, 0, counter.Length);
        Array.Clear(s, 0, s.Length);
        Array.Clear(encryptedJ0, 0, encryptedJ0.Length);
    }

    private static byte[] EncryptBlock(byte[] key, byte[] block)
    {
        using (Aes aes = Aes.Create())
        {
            aes.KeySize = 256;
            aes.BlockSize = 128;
            aes.Mode = CipherMode.ECB;
            aes.Padding = PaddingMode.None;
            aes.Key = key;
            using (ICryptoTransform encryptor = aes.CreateEncryptor())
                return encryptor.TransformFinalBlock(block, 0, 16);
        }
    }

    private static void IncrementCounter(byte[] counter)
    {
        for (int i = 15; i >= 12; i--)
        {
            counter[i]++;
            if (counter[i] != 0) break;
        }
    }

    private static byte[] GHash(byte[] h, byte[] aad, byte[] ciphertext)
    {
        byte[] y = new byte[16];
        HashBlocks(y, h, aad);
        HashBlocks(y, h, ciphertext);
        byte[] lengths = new byte[16];
        WriteUInt64BigEndian(lengths, 0, checked((ulong)aad.LongLength * 8UL));
        WriteUInt64BigEndian(lengths, 8, checked((ulong)ciphertext.LongLength * 8UL));
        XorInPlace(y, lengths);
        byte[] result = Multiply(y, h);
        Array.Clear(y, 0, y.Length);
        Array.Clear(lengths, 0, lengths.Length);
        return result;
    }

    private static void HashBlocks(byte[] y, byte[] h, byte[] data)
    {
        for (int offset = 0; offset < data.Length; offset += 16)
        {
            byte[] block = new byte[16];
            int count = Math.Min(16, data.Length - offset);
            Buffer.BlockCopy(data, offset, block, 0, count);
            XorInPlace(y, block);
            byte[] multiplied = Multiply(y, h);
            Buffer.BlockCopy(multiplied, 0, y, 0, 16);
            Array.Clear(block, 0, block.Length);
            Array.Clear(multiplied, 0, multiplied.Length);
        }
    }

    private static byte[] Multiply(byte[] x, byte[] y)
    {
        byte[] z = new byte[16];
        byte[] v = (byte[])y.Clone();
        for (int bit = 0; bit < 128; bit++)
        {
            if ((x[bit / 8] & (1 << (7 - (bit % 8)))) != 0)
                XorInPlace(z, v);
            bool lsb = (v[15] & 1) != 0;
            int carry = 0;
            for (int i = 0; i < 16; i++)
            {
                int nextCarry = v[i] & 1;
                v[i] = (byte)((v[i] >> 1) | (carry << 7));
                carry = nextCarry;
            }
            if (lsb) v[0] ^= 0xe1;
        }
        Array.Clear(v, 0, v.Length);
        return z;
    }

    private static void XorInPlace(byte[] left, byte[] right)
    {
        for (int i = 0; i < 16; i++) left[i] ^= right[i];
    }

    private static void WriteUInt64BigEndian(byte[] output, int offset, ulong value)
    {
        for (int i = 7; i >= 0; i--)
        {
            output[offset + i] = (byte)(value & 0xff);
            value >>= 8;
        }
    }
}
