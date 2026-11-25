using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Anthropic;
using Anthropic.Exceptions;
using Anthropic.Models.Messages;

namespace Squall.Link.Uno
{
    /// <summary>The Messages API, behind a seam so tests can play the model. Errors are UnoExceptions with plain sentences.</summary>
    public interface IUnoModel
    {
        /// <summary>One Messages API call (client.Messages.Create).</summary>
        Task<Message> CreateAsync(string apiKey, MessageCreateParams request, CancellationToken ct);

        /// <summary>Looks the model up (client.Models.Retrieve, free) and returns its display name.</summary>
        Task<string> CheckAsync(string apiKey, string model, CancellationToken ct);
    }

    /// <summary>The real thing: the official Anthropic C# SDK. The key is only ever handed to the SDK client.</summary>
    public sealed class AnthropicUnoModel : IUnoModel, IDisposable
    {
        private readonly object _lock = new();
        private AnthropicClient? _client;
        private string? _clientKey;

        private AnthropicClient Client(string apiKey)
        {
            lock (_lock)
            {
                if (_client == null || _clientKey != apiKey)
                {
                    _client?.Dispose();
                    _client = new AnthropicClient { ApiKey = apiKey, MaxRetries = 3 };
                    _clientKey = apiKey;
                }
                return _client;
            }
        }

        public async Task<Message> CreateAsync(string apiKey, MessageCreateParams request, CancellationToken ct)
        {
            try { return await Client(apiKey).Messages.Create(request, ct).ConfigureAwait(false); }
            catch (Exception ex) when (Plain(ex, ct) is { } plain) { throw new UnoException(plain); }
        }

        public async Task<string> CheckAsync(string apiKey, string model, CancellationToken ct)
        {
            try
            {
                var info = await Client(apiKey).Models.Retrieve(model, cancellationToken: ct).ConfigureAwait(false);
                return string.IsNullOrWhiteSpace(info.DisplayName) ? info.ID : info.DisplayName;
            }
            catch (Exception ex) when (Plain(ex, ct) is { } plain) { throw new UnoException(plain); }
        }

        /// <summary>A plain sentence for an SDK error (never the key, never a wall of JSON). Null for cancellation.</summary>
        internal static string? Plain(Exception ex, CancellationToken ct)
        {
            if (ex is OperationCanceledException && ct.IsCancellationRequested) return null;
            return ex switch
            {
                AnthropicUnauthorizedException => "The API key didn't work. Check it in Squall Uno's settings.",
                AnthropicForbiddenException => "This API key isn't allowed to use Squall Uno's model. Check the key's workspace in the Anthropic Console.",
                AnthropicNotFoundException => "Anthropic couldn't find Squall Uno's model for this key.",
                AnthropicPaymentRequiredException => "The Anthropic account is out of credit. Add credit in the Anthropic Console.",
                AnthropicRateLimitException => "Anthropic says too many requests right now. Wait a minute and try again.",
                AnthropicOverloadedException => "Anthropic is very busy right now. Try again in a minute.",
                Anthropic5xxException => "Anthropic's servers had a problem. Try again in a minute.",
                AnthropicContentTooLargeException => "This task got too big to send. Start a new task.",
                AnthropicApiException api when api.StatusCode == HttpStatusCode.BadRequest && Mentions(api, "credit balance") =>
                    "The Anthropic account is out of credit. Add credit in the Anthropic Console.",
                AnthropicApiException api => "Anthropic didn't accept the request" + Detail(api) + ".",
                AnthropicIOException => "Squall couldn't reach Anthropic. Check the internet connection.",
                OperationCanceledException => "Anthropic took too long to answer. Try again.",
                System.Net.Http.HttpRequestException => "Squall couldn't reach Anthropic. Check the internet connection.",
                _ => "Something went wrong talking to Anthropic: " + ComputerActions.Short(ex.Message, 140),
            };
        }

        private static bool Mentions(AnthropicApiException api, string words)
        {
            try { return (api.ApiMessage ?? "").Contains(words, StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return false; }
        }

        private static string Detail(AnthropicApiException api)
        {
            string msg;
            try { msg = api.ApiMessage ?? ""; }
            catch (Exception) { msg = ""; }
            msg = msg.Trim().TrimEnd('.');
            return msg.Length == 0 ? "" : ": " + ComputerActions.Short(msg, 160);
        }

        public void Dispose()
        {
            lock (_lock)
            {
                _client?.Dispose();
                _client = null;
                _clientKey = null;
            }
        }
    }
}
