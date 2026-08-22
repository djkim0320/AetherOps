package mcpserver

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/Aether-claw/internal/browser"
)

const (
	defaultScholarlyLimit       = 8
	maxScholarlyLimit           = 20
	maxScholarlyQueryBytes      = 1024
	maxScholarlyResponseBytes   = 4 << 20
	scholarlySearchTimeout      = 30 * time.Second
	scholarlyResponseHeaderSize = 64 << 10
	maxScholarlyAbstractRunes   = 4000
)

var scholarlyWhitespace = regexp.MustCompile(`\s+`)

type scholarlyEndpoints struct {
	Crossref  string
	ArXiv     string
	EuropePMC string
}

func defaultScholarlyEndpoints() scholarlyEndpoints {
	return scholarlyEndpoints{
		Crossref:  "https://api.crossref.org/works",
		ArXiv:     "https://export.arxiv.org/api/query",
		EuropePMC: "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
	}
}

type scholarlySearchResponse struct {
	Query     string                    `json:"query"`
	Providers []scholarlyProviderReport `json:"providers"`
	Results   []scholarlyCandidate      `json:"results"`
}

type scholarlyProviderReport struct {
	Provider string `json:"provider"`
	Status   string `json:"status"`
	Count    int    `json:"count"`
	Error    string `json:"error,omitempty"`
}

type scholarlyCandidate struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Authors       []string `json:"authors"`
	Publisher     string   `json:"publisher,omitempty"`
	Venue         string   `json:"venue,omitempty"`
	PublishedAt   string   `json:"published_at,omitempty"`
	Year          int      `json:"year,omitempty"`
	DOI           string   `json:"doi,omitempty"`
	PMID          string   `json:"pmid,omitempty"`
	PMCID         string   `json:"pmcid,omitempty"`
	ArXivID       string   `json:"arxiv_id,omitempty"`
	URL           string   `json:"url"`
	FullTextURL   string   `json:"full_text_url,omitempty"`
	Abstract      string   `json:"abstract,omitempty"`
	OpenAccess    bool     `json:"open_access"`
	CitationCount int      `json:"citation_count,omitempty"`
	Providers     []string `json:"providers"`
	rank          int
}

type scholarlyProviderResult struct {
	provider   string
	candidates []scholarlyCandidate
	err        error
}

func searchScholarly(
	ctx context.Context,
	policy browser.Policy,
	endpoints scholarlyEndpoints,
	query string,
	limit int,
) (scholarlySearchResponse, error) {
	query = scholarlyWhitespace.ReplaceAllString(strings.TrimSpace(query), " ")
	if query == "" || len(query) > maxScholarlyQueryBytes {
		return scholarlySearchResponse{}, fmt.Errorf("scholarly query must be between 1 and %d UTF-8 bytes", maxScholarlyQueryBytes)
	}
	if limit == 0 {
		limit = defaultScholarlyLimit
	}
	if limit < 1 || limit > maxScholarlyLimit {
		return scholarlySearchResponse{}, fmt.Errorf("scholarly result limit must be between 1 and %d", maxScholarlyLimit)
	}
	defaults := defaultScholarlyEndpoints()
	if strings.TrimSpace(endpoints.Crossref) == "" {
		endpoints.Crossref = defaults.Crossref
	}
	if strings.TrimSpace(endpoints.ArXiv) == "" {
		endpoints.ArXiv = defaults.ArXiv
	}
	if strings.TrimSpace(endpoints.EuropePMC) == "" {
		endpoints.EuropePMC = defaults.EuropePMC
	}

	providers := []struct {
		name string
		run  func(context.Context, browser.Policy, string, string, int) ([]scholarlyCandidate, error)
		url  string
	}{
		{name: "crossref", run: searchCrossref, url: endpoints.Crossref},
		{name: "arxiv", run: searchArXiv, url: endpoints.ArXiv},
		{name: "europe_pmc", run: searchEuropePMC, url: endpoints.EuropePMC},
	}

	providerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan scholarlyProviderResult, len(providers))
	var wait sync.WaitGroup
	wait.Add(len(providers))
	for _, provider := range providers {
		provider := provider
		go func() {
			defer wait.Done()
			candidates, err := provider.run(providerCtx, policy, provider.url, query, limit)
			results <- scholarlyProviderResult{provider: provider.name, candidates: candidates, err: err}
		}()
	}
	wait.Wait()
	close(results)

	byProvider := make(map[string]scholarlyProviderResult, len(providers))
	for result := range results {
		byProvider[result.provider] = result
	}
	response := scholarlySearchResponse{
		Query:     query,
		Providers: make([]scholarlyProviderReport, 0, len(providers)),
		Results:   []scholarlyCandidate{},
	}
	merged := make(map[string]scholarlyCandidate)
	providerFailures := make([]error, 0, len(providers))
	succeeded := 0
	for _, provider := range providers {
		result := byProvider[provider.name]
		report := scholarlyProviderReport{Provider: provider.name, Status: "ok", Count: len(result.candidates)}
		if result.err != nil {
			report.Status = "error"
			report.Error = result.err.Error()
			providerFailures = append(providerFailures, fmt.Errorf("%s: %w", provider.name, result.err))
		} else {
			succeeded++
			for _, candidate := range result.candidates {
				mergeScholarlyCandidate(merged, candidate)
			}
		}
		response.Providers = append(response.Providers, report)
	}
	if succeeded == 0 {
		return scholarlySearchResponse{}, fmt.Errorf("all scholarly providers failed: %w", errors.Join(providerFailures...))
	}
	for _, candidate := range merged {
		candidate.Providers = uniqueSortedStrings(candidate.Providers)
		response.Results = append(response.Results, candidate)
	}
	sort.Slice(response.Results, func(left, right int) bool {
		if response.Results[left].rank != response.Results[right].rank {
			return response.Results[left].rank < response.Results[right].rank
		}
		if response.Results[left].Year != response.Results[right].Year {
			return response.Results[left].Year > response.Results[right].Year
		}
		return response.Results[left].Title < response.Results[right].Title
	})
	if len(response.Results) > limit {
		response.Results = response.Results[:limit]
	}
	return response, nil
}

func mergeScholarlyCandidate(merged map[string]scholarlyCandidate, candidate scholarlyCandidate) {
	candidate.Title = cleanScholarlyText(candidate.Title)
	candidate.Abstract = truncateRunes(cleanScholarlyText(candidate.Abstract), maxScholarlyAbstractRunes)
	candidate.DOI = normalizeDOI(candidate.DOI)
	candidate.PMCID = strings.ToUpper(strings.TrimSpace(candidate.PMCID))
	candidate.ArXivID = normalizeArXivID(candidate.ArXivID)
	key := scholarlyCandidateKey(candidate)
	if key == "" || candidate.Title == "" || candidate.URL == "" {
		return
	}
	candidate.ID = key
	candidate.Authors = uniqueSortedStrings(candidate.Authors)
	existing, ok := merged[key]
	if !ok {
		merged[key] = candidate
		return
	}
	if candidate.rank < existing.rank {
		existing.rank = candidate.rank
	}
	existing.Providers = append(existing.Providers, candidate.Providers...)
	existing.Authors = uniqueSortedStrings(append(existing.Authors, candidate.Authors...))
	existing.OpenAccess = existing.OpenAccess || candidate.OpenAccess
	if candidate.CitationCount > existing.CitationCount {
		existing.CitationCount = candidate.CitationCount
	}
	fillString := func(target *string, value string) {
		if strings.TrimSpace(*target) == "" && strings.TrimSpace(value) != "" {
			*target = value
		}
	}
	fillString(&existing.Publisher, candidate.Publisher)
	fillString(&existing.Venue, candidate.Venue)
	fillString(&existing.PublishedAt, candidate.PublishedAt)
	fillString(&existing.DOI, candidate.DOI)
	fillString(&existing.PMID, candidate.PMID)
	fillString(&existing.PMCID, candidate.PMCID)
	fillString(&existing.ArXivID, candidate.ArXivID)
	fillString(&existing.Abstract, candidate.Abstract)
	fillString(&existing.FullTextURL, candidate.FullTextURL)
	if existing.Year == 0 {
		existing.Year = candidate.Year
	}
	merged[key] = existing
}

func scholarlyCandidateKey(candidate scholarlyCandidate) string {
	if candidate.DOI != "" {
		return "doi:" + strings.ToLower(candidate.DOI)
	}
	if candidate.PMCID != "" {
		return "pmcid:" + strings.ToLower(candidate.PMCID)
	}
	if candidate.ArXivID != "" {
		return "arxiv:" + strings.ToLower(candidate.ArXivID)
	}
	if candidate.PMID != "" {
		return "pmid:" + strings.ToLower(candidate.PMID)
	}
	title := strings.ToLower(cleanScholarlyText(candidate.Title))
	title = strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character >= 0x80 {
			return character
		}
		return -1
	}, title)
	if title == "" {
		return ""
	}
	return "title:" + title
}

func searchCrossref(ctx context.Context, policy browser.Policy, endpoint, query string, limit int) ([]scholarlyCandidate, error) {
	target, err := scholarlyURL(endpoint, url.Values{
		"query.bibliographic": []string{query},
		"rows":                []string{strconv.Itoa(limit)},
		"select":              []string{"DOI,title,author,publisher,published,URL,type,abstract,container-title,link,is-referenced-by-count"},
	})
	if err != nil {
		return nil, err
	}
	body, err := fetchScholarlyResponse(ctx, policy, target, "application/json")
	if err != nil {
		return nil, err
	}
	var payload struct {
		Message struct {
			Items []struct {
				DOI           string   `json:"DOI"`
				Title         []string `json:"title"`
				Publisher     string   `json:"publisher"`
				URL           string   `json:"URL"`
				Abstract      string   `json:"abstract"`
				Container     []string `json:"container-title"`
				CitationCount int      `json:"is-referenced-by-count"`
				Author        []struct {
					Given  string `json:"given"`
					Family string `json:"family"`
					Name   string `json:"name"`
				} `json:"author"`
				Published struct {
					DateParts [][]int `json:"date-parts"`
				} `json:"published"`
				Link []struct {
					URL         string `json:"URL"`
					ContentType string `json:"content-type"`
				} `json:"link"`
			} `json:"items"`
		} `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode Crossref response: %w", err)
	}
	candidates := make([]scholarlyCandidate, 0, len(payload.Message.Items))
	for rank, item := range payload.Message.Items {
		title := firstNonEmpty(item.Title)
		published, year := crossrefDate(item.Published.DateParts)
		authors := make([]string, 0, len(item.Author))
		for _, author := range item.Author {
			name := cleanScholarlyText(strings.TrimSpace(author.Given + " " + author.Family))
			if name == "" {
				name = cleanScholarlyText(author.Name)
			}
			if name != "" {
				authors = append(authors, name)
			}
		}
		fullTextURL := ""
		for _, link := range item.Link {
			if strings.EqualFold(link.ContentType, "application/pdf") {
				fullTextURL = strings.TrimSpace(link.URL)
				break
			}
		}
		landingURL := strings.TrimSpace(item.URL)
		if landingURL == "" && item.DOI != "" {
			landingURL = "https://doi.org/" + normalizeDOI(item.DOI)
		}
		candidates = append(candidates, scholarlyCandidate{
			Title: title, Authors: authors, Publisher: cleanScholarlyText(item.Publisher),
			Venue: firstNonEmpty(item.Container), PublishedAt: published, Year: year,
			DOI: item.DOI, URL: landingURL, FullTextURL: fullTextURL,
			Abstract: item.Abstract, CitationCount: item.CitationCount,
			// Crossref links identify possible full-text locations but do not, by
			// themselves, establish an open-access license.
			OpenAccess: false, Providers: []string{"crossref"}, rank: rank,
		})
	}
	return candidates, nil
}

func searchArXiv(ctx context.Context, policy browser.Policy, endpoint, query string, limit int) ([]scholarlyCandidate, error) {
	target, err := scholarlyURL(endpoint, url.Values{
		"search_query": []string{"all:" + query},
		"start":        []string{"0"},
		"max_results":  []string{strconv.Itoa(limit)},
		"sortBy":       []string{"relevance"},
	})
	if err != nil {
		return nil, err
	}
	body, err := fetchScholarlyResponse(ctx, policy, target, "application/atom+xml, application/xml;q=0.9")
	if err != nil {
		return nil, err
	}
	var feed struct {
		Entries []struct {
			ID        string `xml:"id"`
			Title     string `xml:"title"`
			Summary   string `xml:"summary"`
			Published string `xml:"published"`
			DOI       string `xml:"doi"`
			Authors   []struct {
				Name string `xml:"name"`
			} `xml:"author"`
			Links []struct {
				Href  string `xml:"href,attr"`
				Rel   string `xml:"rel,attr"`
				Type  string `xml:"type,attr"`
				Title string `xml:"title,attr"`
			} `xml:"link"`
		} `xml:"entry"`
	}
	if err := xml.Unmarshal(body, &feed); err != nil {
		return nil, fmt.Errorf("decode arXiv response: %w", err)
	}
	candidates := make([]scholarlyCandidate, 0, len(feed.Entries))
	for rank, entry := range feed.Entries {
		authors := make([]string, 0, len(entry.Authors))
		for _, author := range entry.Authors {
			if name := cleanScholarlyText(author.Name); name != "" {
				authors = append(authors, name)
			}
		}
		landingURL := strings.TrimSpace(entry.ID)
		fullTextURL := ""
		for _, link := range entry.Links {
			if strings.EqualFold(link.Type, "application/pdf") || strings.EqualFold(link.Title, "pdf") {
				fullTextURL = strings.TrimSpace(link.Href)
			}
			if landingURL == "" && strings.EqualFold(link.Rel, "alternate") {
				landingURL = strings.TrimSpace(link.Href)
			}
		}
		publishedAt, year := parsePublishedDate(entry.Published)
		candidates = append(candidates, scholarlyCandidate{
			Title: entry.Title, Authors: authors, Publisher: "arXiv", Venue: "arXiv",
			PublishedAt: publishedAt, Year: year, DOI: entry.DOI,
			ArXivID: arXivIDFromURL(landingURL), URL: landingURL, FullTextURL: fullTextURL,
			Abstract: entry.Summary, OpenAccess: fullTextURL != "",
			Providers: []string{"arxiv"}, rank: rank,
		})
	}
	return candidates, nil
}

func searchEuropePMC(ctx context.Context, policy browser.Policy, endpoint, query string, limit int) ([]scholarlyCandidate, error) {
	target, err := scholarlyURL(endpoint, url.Values{
		"query":      []string{query},
		"format":     []string{"json"},
		"resultType": []string{"core"},
		"pageSize":   []string{strconv.Itoa(limit)},
	})
	if err != nil {
		return nil, err
	}
	body, err := fetchScholarlyResponse(ctx, policy, target, "application/json")
	if err != nil {
		return nil, err
	}
	var payload struct {
		ResultList struct {
			Results []struct {
				ID                   string `json:"id"`
				Source               string `json:"source"`
				PMID                 string `json:"pmid"`
				PMCID                string `json:"pmcid"`
				DOI                  string `json:"doi"`
				Title                string `json:"title"`
				AuthorString         string `json:"authorString"`
				JournalTitle         string `json:"journalTitle"`
				PubYear              string `json:"pubYear"`
				FirstPublicationDate string `json:"firstPublicationDate"`
				AbstractText         string `json:"abstractText"`
				IsOpenAccess         string `json:"isOpenAccess"`
				InPMC                string `json:"inPMC"`
				CitedByCount         int    `json:"citedByCount"`
				FullTextURLList      struct {
					URLs []struct {
						Availability  string `json:"availability"`
						DocumentStyle string `json:"documentStyle"`
						URL           string `json:"url"`
					} `json:"fullTextUrl"`
				} `json:"fullTextUrlList"`
			} `json:"result"`
		} `json:"resultList"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode Europe PMC response: %w", err)
	}
	candidates := make([]scholarlyCandidate, 0, len(payload.ResultList.Results))
	for rank, item := range payload.ResultList.Results {
		authors := splitAuthors(item.AuthorString)
		year, _ := strconv.Atoi(strings.TrimSpace(item.PubYear))
		publishedAt, parsedYear := parsePublishedDate(item.FirstPublicationDate)
		if year == 0 {
			year = parsedYear
		}
		landingURL := "https://europepmc.org/article/" + url.PathEscape(item.Source) + "/" + url.PathEscape(item.ID)
		fullTextURL := ""
		for _, candidateURL := range item.FullTextURLList.URLs {
			if strings.TrimSpace(candidateURL.URL) == "" {
				continue
			}
			if fullTextURL == "" || strings.EqualFold(candidateURL.DocumentStyle, "pdf") {
				fullTextURL = strings.TrimSpace(candidateURL.URL)
			}
			if strings.EqualFold(candidateURL.DocumentStyle, "pdf") {
				break
			}
		}
		if fullTextURL == "" && strings.TrimSpace(item.PMCID) != "" && strings.EqualFold(item.InPMC, "Y") {
			fullTextURL = "https://www.ebi.ac.uk/europepmc/webservices/rest/" + url.PathEscape(item.PMCID) + "/fullTextXML"
		}
		candidates = append(candidates, scholarlyCandidate{
			Title: item.Title, Authors: authors, Publisher: "Europe PMC", Venue: item.JournalTitle,
			PublishedAt: publishedAt, Year: year, DOI: item.DOI, PMID: item.PMID, PMCID: item.PMCID,
			URL: landingURL, FullTextURL: fullTextURL, Abstract: item.AbstractText,
			OpenAccess:    strings.EqualFold(item.IsOpenAccess, "Y") || fullTextURL != "",
			CitationCount: item.CitedByCount, Providers: []string{"europe_pmc"}, rank: rank,
		})
	}
	return candidates, nil
}

func fetchScholarlyResponse(ctx context.Context, policy browser.Policy, rawURL, accept string) ([]byte, error) {
	canonical, err := canonicalEvidenceURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid scholarly provider URL: %w", err)
	}
	if err := policy.ValidateURL(ctx, canonical); err != nil {
		return nil, fmt.Errorf("scholarly provider URL is blocked: %w", err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, scholarlySearchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, canonical, nil)
	if err != nil {
		return nil, errors.New("construct scholarly request")
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "AetherOps/0.1 scholarly-search")
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            policy.DialContext,
		ForceAttemptHTTP2:      true,
		DisableKeepAlives:      true,
		MaxConnsPerHost:        1,
		TLSHandshakeTimeout:    15 * time.Second,
		ResponseHeaderTimeout:  20 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: scholarlyResponseHeaderSize,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= maxEvidenceRedirects {
				return errors.New("scholarly redirect limit exceeded")
			}
			redirect, err := canonicalEvidenceURL(next.URL.String())
			if err != nil {
				return err
			}
			if err := policy.ValidateURL(next.Context(), redirect); err != nil {
				return fmt.Errorf("blocked scholarly redirect: %w", err)
			}
			if len(via) > 0 && strings.EqualFold(via[len(via)-1].URL.Scheme, "https") && !strings.EqualFold(next.URL.Scheme, "https") {
				return errors.New("HTTPS scholarly provider cannot redirect to plaintext HTTP")
			}
			next.Header.Del("Authorization")
			next.Header.Del("Cookie")
			next.Header.Set("Accept-Encoding", "identity")
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("query scholarly provider: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scholarly provider returned HTTP status %d", response.StatusCode)
	}
	if response.ContentLength > maxScholarlyResponseBytes {
		return nil, errors.New("scholarly provider response exceeds 4 MiB")
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return nil, fmt.Errorf("unsupported scholarly response encoding %q", encoding)
	}
	if rawType := strings.TrimSpace(response.Header.Get("Content-Type")); rawType != "" {
		mediaType, _, err := mime.ParseMediaType(rawType)
		if err != nil || !(strings.Contains(mediaType, "json") || strings.Contains(mediaType, "xml") || strings.Contains(mediaType, "atom")) {
			return nil, fmt.Errorf("unsupported scholarly response media type %q", rawType)
		}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxScholarlyResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read scholarly response: %w", err)
	}
	if len(body) == 0 || len(body) > maxScholarlyResponseBytes {
		return nil, errors.New("scholarly provider response is empty or exceeds 4 MiB")
	}
	return body, nil
}

func scholarlyURL(endpoint string, values url.Values) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil {
		return "", errors.New("scholarly provider endpoint is invalid")
	}
	query := parsed.Query()
	for key, entries := range values {
		query.Del(key)
		for _, value := range entries {
			query.Add(key, value)
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func crossrefDate(parts [][]int) (string, int) {
	if len(parts) == 0 || len(parts[0]) == 0 {
		return "", 0
	}
	year := parts[0][0]
	month, day := 1, 1
	if len(parts[0]) > 1 && parts[0][1] >= 1 && parts[0][1] <= 12 {
		month = parts[0][1]
	}
	if len(parts[0]) > 2 && parts[0][2] >= 1 && parts[0][2] <= 31 {
		day = parts[0][2]
	}
	if year <= 0 {
		return "", 0
	}
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day), year
}

func parsePublishedDate(raw string) (string, int) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", 0
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02", "2006-01", "2006"} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.Format("2006-01-02"), parsed.Year()
		}
	}
	if len(raw) >= 4 {
		year, _ := strconv.Atoi(raw[:4])
		return raw, year
	}
	return raw, 0
}

func splitAuthors(raw string) []string {
	parts := strings.FieldsFunc(raw, func(character rune) bool { return character == ',' || character == ';' })
	authors := make([]string, 0, len(parts))
	for _, part := range parts {
		if name := cleanScholarlyText(part); name != "" {
			authors = append(authors, name)
		}
	}
	return authors
}

func normalizeDOI(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(strings.TrimPrefix(value, "https://doi.org/"), "http://doi.org/")
	value = strings.TrimPrefix(strings.TrimPrefix(value, "doi:"), "DOI:")
	return strings.TrimSpace(value)
}

func arXivIDFromURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	path := strings.TrimPrefix(parsed.Path, "/")
	path = strings.TrimPrefix(path, "abs/")
	path = strings.TrimPrefix(path, "pdf/")
	return normalizeArXivID(strings.TrimSuffix(path, ".pdf"))
}

func normalizeArXivID(raw string) string {
	value := strings.TrimSpace(raw)
	if index := strings.LastIndex(value, "v"); index > 0 {
		if _, err := strconv.Atoi(value[index+1:]); err == nil {
			value = value[:index]
		}
	}
	return value
}

func cleanScholarlyText(raw string) string {
	return scholarlyWhitespace.ReplaceAllString(strings.TrimSpace(raw), " ")
}

func truncateRunes(raw string, limit int) string {
	runes := []rune(raw)
	if len(runes) <= limit {
		return raw
	}
	return string(runes[:limit])
}

func firstNonEmpty(values []string) string {
	for _, value := range values {
		if cleaned := cleanScholarlyText(value); cleaned != "" {
			return cleaned
		}
	}
	return ""
}

func uniqueSortedStrings(values []string) []string {
	seen := make(map[string]string, len(values))
	for _, value := range values {
		cleaned := cleanScholarlyText(value)
		if cleaned == "" {
			continue
		}
		key := strings.ToLower(cleaned)
		if _, exists := seen[key]; !exists {
			seen[key] = cleaned
		}
	}
	result := make([]string, 0, len(seen))
	for _, value := range seen {
		result = append(result, value)
	}
	sort.Slice(result, func(left, right int) bool { return strings.ToLower(result[left]) < strings.ToLower(result[right]) })
	return result
}
