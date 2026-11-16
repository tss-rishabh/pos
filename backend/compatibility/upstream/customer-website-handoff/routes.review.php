<?php
// ADDITIVE REVIEW CANDIDATE for laravel-web cd02b3476cbb58d3d89f0ee32b77d74586021104.
// Install only after actual website/auth/order-attribution acceptance. No legacy pos-login receiver was found.
// Load PosWebsiteHandoff.php through the application's class loader; do not expose it as a public file.
// Config::get('pos_handoff') must hold contract/receiver_url/redemption_url/service_key server-side.

$handoffHeaders = function($response,$nonce=null) {
    $response->header('Cache-Control','no-store');
    $response->header('Referrer-Policy','no-referrer');
    $response->header('X-Content-Type-Options','nosniff');
    $response->header('Content-Security-Policy',"default-src 'none'; script-src 'nonce-".$nonce."'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return $response;
};
Route::get('/pos/secure-login',function() use ($handoffHeaders) {
    try {
        $config=PosWebsiteHandoff::configuration(Config::get('pos_handoff'));
        if(!Request::secure() || Request::root()!==$config['origin'] || Request::getQueryString())PosWebsiteHandoff::unavailable();
        $binding=Session::get('pos_handoff_receiver_binding');
        if(!PosWebsiteHandoff::opaque($binding)){ $binding=PosWebsiteHandoff::randomToken();Session::put('pos_handoff_receiver_binding',$binding); }
        $csrf=Session::token();
        if(!is_string($csrf)||!preg_match('/\A[A-Za-z0-9_-]{32,128}\z/D',$csrf)){$csrf=PosWebsiteHandoff::randomToken();Session::put('_token',$csrf);}
        $nonce=PosWebsiteHandoff::randomToken();
        $html=file_get_contents(__DIR__.'/receiver.html');
        if($html===false)PosWebsiteHandoff::unavailable();
        $html=str_replace(array('__NONCE__','__CSRF__','__OPERATION__'),array($nonce,$csrf,PosWebsiteHandoff::operationId()),$html);
        return $handoffHeaders(Response::make($html,200,array('Content-Type'=>'text/html; charset=utf-8')),$nonce);
    }catch(Exception $ignored){return $handoffHeaders(Response::make('Customer website sign-in is unavailable.',503));}
});
Route::post('/pos/secure-login',function() use ($handoffHeaders) {
    try {
        $config=PosWebsiteHandoff::configuration(Config::get('pos_handoff'));
        $body=Request::instance()->getContent();
        if(!Request::secure() || Request::root()!==$config['origin'] || Request::header('Origin')!==$config['origin'] ||
            Request::getQueryString() || strpos(Request::header('Content-Type'),'application/json')!==0 || strlen($body)>4096)
            PosWebsiteHandoff::unavailable();
        $input=PosWebsiteHandoff::input(json_decode($body,true),Session::token());
        $binding=Session::get('pos_handoff_receiver_binding');
        $receipt=PosWebsiteHandoff::redeem($config,$input,$binding);
        $customer=User::on($config['customerConnection'])->find($receipt['customerId']); // Explicit qualified writer; no DB lock spans HTTP.
        PosWebsiteHandoff::establish($receipt,$customer,$binding);
        return $handoffHeaders(Response::json(array('status'=>'signed-in')));
    }catch(Exception $ignored){return $handoffHeaders(Response::json(array('status'=>'unavailable'),409));}
});
// Register on EVERY sessionful route of this qualified website, before its auth/checkout action.
// Secure HttpOnly SameSite cookies + server-side session store are deployment prerequisites.
App::before(function(){PosWebsiteHandoff::expireIfRequired((int)floor(microtime(true)*1000));});
