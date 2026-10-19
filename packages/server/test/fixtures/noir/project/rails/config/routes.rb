Rails.application.routes.draw do
  resources :articles, only: [:index, :show]
  get "/health", to: "health#show"
end
